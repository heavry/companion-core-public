import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { stableJson } from "../utils.js";
import { config } from "../config.js";

// Module Tool Execution Ledger —— 持久化、crash-safe、有界。
//
// 目标：同一条逻辑 Module Tool invocation（request replay / concurrent duplicate /
// interrupted continuation 重放）至多执行一次 handler；
// 真正的新 tool_call（新对话轮次 / loop 内后续步骤）照常执行。
//
// Execution Key = sessionId | moduleId | toolName | stableJson(args)
// Replay 判别    = turn 指纹（客户端原始负载哈希）+ loop 内 tool 步骤序号。
//
// 持久化生命周期（写入先于副作用）：
//   execution key → 持久化 pending → handler → completed/failed → 再次持久化
//   崩溃后遗留的 pending 一律视为 uncertain，禁止自动重执行（at-most-once 优先）。
//
// 状态机：
//   pending   已持久化，handler 进行中；并发重复共享 in-flight promise
//   completed 结果可回放（重启后回放存储的紧凑结果文本）
//   failed    同指纹最多 MAX_ATTEMPTS 次（计数随文件持久化，重启不清零）
//   uncertain 重启后发现的历史 pending：无法区分"未执行"与"已执行但未记录"，
//             返回明确的不确定结果，绝不偷偷重跑
//
// 已知边界：无 key 且逐字节相同的极简重复请求与重试在协议层不可区分；
// Agent 客户端（OpenCode/Harness）携带完整历史自然可区分；Kelivo 聊天路径不经过
// Module Tool。需要强制重执行时客户端附带新的 Idempotency-Key 即可。

const MAX_ATTEMPTS=2;
const LEDGER_VERSION=1;
// uncertain 的安全回放结果：明确告知模型/客户端该次执行状态无法确认
const UNCERTAIN_RESULT_TEXT="[module execution uncertain] 上一次进程在该工具执行期间崩溃，无法确认副作用是否已发生；为避免重复产生副作用未重新执行。如确需重试，请携带新的 Idempotency-Key 发起新请求。";

function atomicWrite(file,data){
  const tmp=`${file}.${process.pid}.tmp`;
  let fd=-1;
  try{
    fd=fs.openSync(tmp,"w");
    fs.writeFileSync(fd,data);
    fs.fsyncSync(fd);
  }finally{
    if(fd>=0){try{fs.closeSync(fd);}catch{}}
  }
  fs.renameSync(tmp,file);
  try{
    const dirFd=fs.openSync(path.dirname(file),"r");
    try{fs.fsyncSync(dirFd);}finally{fs.closeSync(dirFd);}
  }catch{}
}

const BLOCKED_RESULT_TEXT="[module execution blocked] Module execution ledger is unavailable/corrupt; side-effecting module execution was blocked to avoid duplicate actions.";

export class ExecutionLedger{
  constructor({filePath,ttlMs=600000,maxEntries=4096,resultChars=2048}={}){
    this.filePath=filePath;
    this.ttlMs=Math.max(250,ttlMs);
    this.maxEntries=Math.max(16,maxEntries);
    this.resultChars=Math.max(128,resultChars);
    this.records=new Map();
    this.persistErrors=0;
    this._health="healthy";
    this._corruptBackup=null;
    this.load();
  }

  get health(){return this._health;}
  get corruptBackup(){return this._corruptBackup;}

  /**
   * 人工恢复（必须由用户显式触发，Core 绝不自动调用）：
   * 写入全新的空台账并恢复 healthy。
   * 警告：旧请求的执行状态将无法恢复，之后对相同逻辑请求的重放可能造成重复副作用。
   */
  resetManual(){
    this.records.clear();
    this.persistErrors=0;
    this._health="healthy";
    this.persist();
    return this.health;
  }

  static keyFor({sessionId,moduleId,toolName,args}){
    return `${sessionId}\u0000${moduleId}\u0000${toolName}\u0000${stableJson(args??null)}`;
  }

  /* ---------- 持久化 ---------- */

  static isValidRecordShape(r){
    if(!r||typeof r!=="object"||Array.isArray(r))return false;
    if(!["pending","completed","failed","uncertain"].includes(r.status))return false;
    if(typeof r.fingerprint!=="string")return false;
    const attempts=Number(r.attempts);
    if(!Number.isFinite(attempts)||attempts<0)return false;
    if(r.text!==undefined&&typeof r.text!=="string")return false;
    return true;
  }

  load(){
    let raw=null;
    try{raw=fs.readFileSync(this.filePath,"utf8");}catch(e){
      if(e?.code!=="ENOENT"){this.persistErrors++;this.markCorrupt(null);}
      return;
    }
    let parsed;
    try{parsed=JSON.parse(raw);}
    catch{this.markCorrupt();return;}
    // schema/version/records 结构严格校验 —— 任何非法一律 fail closed
    if(!parsed||parsed.version!==LEDGER_VERSION||typeof parsed.records!=="object"||Array.isArray(parsed.records)){this.markCorrupt();return;}
    for(const [key,record] of Object.entries(parsed.records)){
      if(!key||!ExecutionLedger.isValidRecordShape(record)){this.markCorrupt();return;}
    }
    const now=Date.now();
    let demotedPending=false;
    for(const [key,record] of Object.entries(parsed.records)){
      // 重启后发现的历史 pending：无法判断 handler 是否已执行 → uncertain，禁止自动重跑
      if(record.status==="pending"){record.status="uncertain";demotedPending=true;}
      if((record.status==="completed"||record.status==="failed")&&Number(record.expiresAt)<=now)continue;
      this.records.set(key,this.normalize(record));
    }
    // pending→uncertain 的降级需要立刻落盘，防止再次崩溃后又被当作 pending
    if(demotedPending)this.persist();
  }

  markCorrupt(){
    // 隔离原始文件作为证据，但绝不静默清空后照常运行：
    // 进入 corrupt 健康态，所有非 none 副作用模块工具被阻止执行（fail closed）。
    this._health="corrupt";
    this.records.clear();
    try{
      const stamp=new Date().toISOString().replace(/[:.]/g,"-");
      const backup=`${this.filePath}.corrupt-${stamp}`;
      fs.renameSync(this.filePath,backup);
      this._corruptBackup=backup;
    }catch{
      this._corruptBackup=this.filePath;
    }
    console.error("[modules] execution ledger is CORRUPT; quarantined. Side-effecting module tools are BLOCKED until manual reset (POST /admin/modules/ledger/reset).");
  }

  normalize(record){
    return {
      fingerprint:String(record.fingerprint??""),
      status:record.status,
      attempts:Math.max(0,Number(record.attempts)||0),
      text:typeof record.text==="string"?record.text:"",
      textSha256:typeof record.textSha256==="string"?record.textSha256:"",
      truncated:Boolean(record.truncated),
      moduleId:String(record.moduleId??""),tool:String(record.tool??""),session:String(record.session??""),
      sideEffect:["none","idempotent","non_idempotent"].includes(record.sideEffect)?record.sideEffect:"non_idempotent",
      createdAt:Number(record.createdAt)||Date.now(),
      updatedAt:Number(record.updatedAt)||Date.now(),
      expiresAt:Number(record.expiresAt)||0
    };
  }

  persist(){
    if(this._health==="corrupt")return; // 损坏期间禁止重建/覆盖证据
    try{
      fs.mkdirSync(path.dirname(this.filePath),{recursive:true});
      atomicWrite(this.filePath,this.snapshot());
    }catch(e){
      this.persistErrors++;
      console.error("[modules] ledger persist failed:",e?.message??e);
    }
  }

  snapshot(){
    const records={};
    for(const [key,r] of this.records){
      records[key]={...r};
      delete records[key].promise;
    }
    return JSON.stringify({version:LEDGER_VERSION,savedAt:new Date().toISOString(),records},null,1);
  }

  /** 仅完成态受 TTL/GC 约束；pending/uncertain 是活跃状态，绝不被容量或过期清理 */
  sweep(now=Date.now()){
    for(const [key,r] of this.records){
      if((r.status==="completed"||r.status==="failed")&&r.expiresAt&&r.expiresAt<=now)this.records.delete(key);
    }
  }

  evictIfNeeded(){
    this.sweep();
    if(this.records.size<this.maxEntries)return;
    // 先淘汰最老的已终结记录
    for(const key of this.records.keys()){
      const r=this.records.get(key);
      if(r.status==="completed"||r.status==="failed"){this.records.delete(key);if(this.records.size<this.maxEntries)return;}
    }
  }

  stats(){
    let pending=0,completed=0,failed=0,uncertain=0;
    for(const r of this.records.values()){
      if(r.status==="pending")pending++;
      else if(r.status==="completed")completed++;
      else if(r.status==="failed")failed++;
      else if(r.status==="uncertain")uncertain++;
    }
    return {entries:this.records.size,pending,completed,failed,uncertain,max_attempts:MAX_ATTEMPTS,persistent:true,persist_errors:this.persistErrors,health:this._health};
  }

  /* ---------- 执行入口 ---------- */

  async run({sessionId,moduleId,toolName,args,fingerprint,execute,sideEffect="non_idempotent"}){
    // Fail closed：台账损坏期间，非 none 副作用工具一律阻止执行（handler 绝不调用）
    if(this._health==="corrupt"){
      if(sideEffect!=="none")return {text:BLOCKED_RESULT_TEXT,replayed:false,blocked:true};
      // sideEffect==="none" 的纯读工具无重复副作用风险，允许旁路台账直接执行
      try{
        const outcome=await execute();
        return {text:outcome.text,replayed:false};
      }catch(e){
        return {text:`[module tool error] ${e?.message??String(e)}`,replayed:false};
      }
    }
    if(typeof fingerprint!=="string"||!fingerprint.length)fingerprint="no-fingerprint";
    const key=ExecutionLedger.keyFor({sessionId,moduleId,toolName,args});
    const now=Date.now();
    let record=this.records.get(key);

    if(record&&record.fingerprint===fingerprint){
      if(record.status==="pending"){
        const outcome=await record.promise;
        return {...outcome,replayed:true};
      }
      if(record.status==="uncertain")return {text:record.text||UNCERTAIN_RESULT_TEXT,replayed:true,uncertain:true};
      if(record.status==="completed")return {text:record.text,replayed:true};
      if(record.status==="failed"&&record.attempts>=MAX_ATTEMPTS)return {text:record.text,replayed:true};
      // failed 未达上限：原位复用记录（保留持久化计数）进行最后一次尝试
    }else{
      this.evictIfNeeded();
      record={
        fingerprint,
        status:"pending",
        attempts:0,
        text:"",textSha256:"",truncated:false,
        moduleId,tool:toolName,session:sessionId,
        sideEffect,
        createdAt:now,updatedAt:now,
        expiresAt:0
      };
      this.records.set(key,record);
      this.persist();
    }

    record.status="pending";
    record.updatedAt=Date.now();
    // 关键顺序：pending 必须先持久化成功，再开始调用 handler
    this.persist();
    record.promise=(async()=>{
      const outcome=await execute();
      record.text=outcome.text.slice(0,this.resultChars);
      record.truncated=outcome.text.length>record.text.length;
      record.textSha256=crypto.createHash("sha256").update(outcome.text).digest("hex");
      if(outcome.outcome==="failed"){
        record.attempts+=1;
        record.status="failed";
      }else{
        record.status="completed";
      }
      record.expiresAt=Date.now()+this.ttlMs;
      record.updatedAt=Date.now();
      return {text:outcome.text,replayed:false};
    })();
    try{
      const result=await record.promise;
      this.persist();
      return result;
    }catch(e){
      this.persist();
      throw e;
    }finally{
      record.promise=null;
    }
  }
}

export const moduleExecutionLedger=new ExecutionLedger({
  filePath:config.moduleExecutionLedgerPath,
  ttlMs:config.moduleExecutionLedgerTtlMs,
  maxEntries:config.moduleExecutionLedgerMaxEntries,
  resultChars:config.moduleExecutionLedgerResultStoreChars
});
