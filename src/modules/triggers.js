import crypto from "node:crypto";
import { config } from "../config.js";
import { insertEvent,onEventInserted } from "../db.js";
import { filterSharedMemoryCandidate } from "../memory-policy.js";
import { getHandler,callModuleHandler } from "./sandbox.js";
import { safeErrorMessage } from "../runtime.js";

// Trigger Engine v0.2.6 最小基础：
// 支持 manual / interval / event_created 三种触发类型。
// 防递归：depth guard + cooldown + 幂等去重。
// 事件由 Core 代为写入（经 filterSharedMemoryCandidate 过滤），
// 模块永远不直接接触数据库。

const IDEMPOTENCY_WINDOW_MS=60000;

class TriggerEngine{
  constructor(){
    this.timer=null;
    this.intervalTriggers=new Map();
    this.lastRun=new Map();
    this.idempotency=new Map();
    this.running=false;
  }

  attach(registry){this.registry=registry;}

  start(){
    if(this.timer||!this.registry?.ready)return;
    this.syncFromRegistry(this.registry);
    this.timer=setInterval(()=>this.tick().catch(()=>{}),config.moduleTriggerTickMs);
    this.timer.unref?.();
  }

  stop(){
    if(this.timer)clearInterval(this.timer);
    this.timer=null;
  }

  triggerKey(moduleId,tid){return `${moduleId}:${tid}`;}

  cooldownMs(trigger){
    if(trigger.type==="interval")return Math.max(config.moduleTriggerMinSeconds,(trigger.everySeconds??config.moduleTriggerMinSeconds))*1000;
    return config.moduleTriggerMinSeconds*1000;
  }

  syncFromRegistry(registry){
    this.intervalTriggers=new Map();
    for(const mod of registry.modules.values()){
      if(!mod.enabled||!mod.instance)continue;
      for(const trigger of mod.manifest.triggers){
        const key=this.triggerKey(mod.id,trigger.id);
        if(trigger.type==="interval"){
          const nextRunAt=this.nextRunAtFromState(key)??Date.now()+this.cooldownMs(trigger);
          this.intervalTriggers.set(key,{moduleId:mod.id,trigger,nextRunAt});
        }
      }
    }
  }

  nextRunAtFromState(key){
    const value=this.registry.state.triggers?.[key.split(":")[0]]?.[key.split(":")[1]]?.nextRunAt;
    const ts=Date.parse(value??"");
    return Number.isFinite(ts)?ts:null;
  }

  persistTriggerState(moduleId,tid,{lastRunAt,nextRunAt}){
    if(!this.registry.state.triggers[moduleId])this.registry.state.triggers[moduleId]={};
    this.registry.state.triggers[moduleId][tid]={lastRunAt:new Date(lastRunAt).toISOString(),nextRunAt:nextRunAt?new Date(nextRunAt).toISOString():null};
    this.registry.flushState();
  }

  describeTriggers(mod){
    return mod.manifest.triggers.map(t=>{
      const key=this.triggerKey(mod.id,t.id),state=this.intervalTriggers.get(key);
      return {...t,everySeconds:t.everySeconds,
        enabled:mod.enabled&&Boolean(mod.instance),
        lastRunAt:this.registry.state.triggers?.[mod.id]?.[t.id]?.lastRunAt??null,
        nextRunAt:state?new Date(state.nextRunAt).toISOString():(t.type==="interval"?this.registry.state.triggers?.[mod.id]?.[t.id]?.nextRunAt??null:null)};
    });
  }

  guardChecks(key,payloadHash,now){
    const last=this.lastRun.get(key);
    if(last&&now-last<this.cooldownFor(key))return "cooldown";
    const seen=this.idempotency.get(`${key}:${payloadHash}`);
    if(seen&&now-seen<IDEMPOTENCY_WINDOW_MS)return "duplicate";
    return null;
  }

  cooldownFor(key){
    const entry=key.split(":");
    const mod=this.registry.getModule(entry[0]);
    const trigger=mod?.manifest.triggers.find(t=>t.id===entry[1]);
    return trigger?this.cooldownMs(trigger):config.moduleTriggerMinSeconds*1000;
  }

  async run(moduleId,tid,{depth=0,event=null}={}){
    const now=Date.now(),key=this.triggerKey(moduleId,tid);
    const mod=this.registry.getModule(moduleId);
    if(!mod?.enabled||!mod.instance)return {ok:false,reason:"module_disabled"};
    const trigger=mod.manifest.triggers.find(t=>t.id===tid);
    if(!trigger)return {ok:false,reason:"trigger_not_found"};
    if(depth>config.moduleTriggerMaxDepth)return {ok:false,reason:"depth_guard"};
    if(event&&trigger.type!=="event_created")return {ok:false,reason:"trigger_type_mismatch"};
    const payloadHash=crypto.createHash("sha256").update(JSON.stringify({content:event?.content??"",type:event?.type??""})).digest("hex").slice(0,32);
    const blocked=this.guardChecks(key,payloadHash,now);
    if(blocked==="cooldown")return {ok:false,reason:"cooldown"};
    if(blocked==="duplicate")return {ok:false,reason:"duplicate_suppressed"};
    this.lastRun.set(key,now);
    this.idempotency.set(`${key}:${payloadHash}`,now);
    for(const [k,v] of this.idempotency)if(now-v>IDEMPOTENCY_WINDOW_MS)this.idempotency.delete(k);

    const handler=getHandler(mod.instance.exports,"triggers",tid);
    if(typeof handler!=="function"){this.registry.recordError(mod,`trigger "${tid}" has no exported handler`);return {ok:false,reason:"handler_missing"};}
    const outcome=await callModuleHandler(handler,{
      trigger:{id:trigger.id,type:trigger.type,config:trigger.config},
      event:event?{content:event.content,importance:event.importance}:null,
      depth
    });
    let emitted=false;
    if(!outcome.ok){
      this.registry.recordError(mod,`trigger "${tid}" failed: ${safeErrorMessage(outcome.error)}`);
    }else{
      const result=outcome.value;
      if(result&&typeof result==="object"&&!Array.isArray(result)&&result.event){
        emitted=this.emitModuleEvent(mod,result.event,depth);
      }
    }
    const nextRunAt=trigger.type==="interval"?now+this.cooldownMs(trigger):null;
    const stateEntry=this.intervalTriggers.get(key);
    if(stateEntry)stateEntry.nextRunAt=nextRunAt??stateEntry.nextRunAt;
    this.persistTriggerState(moduleId,tid,{lastRunAt:now,nextRunAt});
    return {ok:outcome.ok,emitted_event:emitted};
  }

  emitModuleEvent(mod,event,depth){
    const content=String(event?.content??"").trim();
    const importance=Math.max(0,Math.min(1,Number(event?.importance)||0.5));
    if(content.length<3||content.length>500)return false;
    // 模块事件走受控通道：保留 unsafePatterns（secret/代码/终端输出）过滤，
    // 但不做 Agent 会话的 durable 过滤 —— 这是 Trigger Engine 的设计内输出，不是会话摘要。
    const safe=filterSharedMemoryCandidate({content,type:"event",source:`module:${mod.id}`,agent:false});
    if(!safe.ok)return false;
    const inserted=insertEvent({personaId:config.defaultPersonaId,sessionId:null,source:`module:${mod.id}`,content:safe.content,importance});
    if(inserted)setImmediate(()=>this.onEventInserted({source:`module:${mod.id}`,content:safe.content,importance},depth+1).catch(()=>{}));
    return inserted;
  }

  async tick(){
    if(this.running||!this.registry?.ready)return;
    this.running=true;
    try{
      const now=Date.now();
      for(const [key,state] of this.intervalTriggers){
        if(state.nextRunAt>now)continue;
        state.nextRunAt=now+this.cooldownMs(state.trigger);
        await this.run(state.moduleId,state.trigger.id,{depth:0}).catch(()=>{});
      }
    }finally{this.running=false;}
  }

  async onEventInserted(record,depth=1){
    for(const mod of this.registry.modules.values()){
      if(!mod.enabled||!mod.instance)continue;
      for(const trigger of mod.manifest.triggers){
        if(trigger.type!=="event_created")continue;
        const cfg=trigger.config??{},filterType=cfg.eventSourceFilter;
        if(filterType&&!String(record.source).startsWith(String(filterType)))continue;
        await this.run(mod.id,trigger.id,{depth,event:{content:record.content,importance:Number(record.importance)||0.5}}).catch(()=>{});
      }
    }
  }
}

export const triggerEngine=new TriggerEngine();

export function installEventHook(){
  onEventInserted.fn=record=>triggerEngine.onEventInserted(record,1);
}
