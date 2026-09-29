import { config } from "../config.js";
import { listRecentEvents } from "../db.js";
import { retrieveMemories } from "../memory.js";
import { assertPermission } from "./permissions.js";
import { PROTECTED_TOOL_NAMES, isValidToolName } from "../tool-registry.js";
import { saveMedia } from "../media.js";
import { safeErrorMessage } from "../runtime.js";
import { publishEvent } from "../events-bus.js";

function denied(name){
  const e=new Error(`module permission denied: ${name}`);
  e.code="PERMISSION_DENIED";e.permission=name;
  return e;
}

// v0.2.6.2：host/domain allowlist 细化。manifest 声明 network_allowlist: ["api.open-meteo.com"]
// 时强制生效；未声明的既有模块保持旧行为（兼容迁移，不破坏 weather/search）。
function assertHostAllowed(manifest,url){
  const allowlist=Array.isArray(manifest?.network_allowlist)?manifest.network_allowlist:null;
  if(!allowlist||!allowlist.length)return;
  let host="";
  try{host=new URL(String(url)).hostname.toLowerCase();}catch{}
  const normalized=host.replace(/^www\./,"");
  const allowed=allowlist.some(pattern=>{
    const p=String(pattern).toLowerCase().replace(/^www\./,"");
    return normalized===p||normalized.endsWith(`.${p}`);
  });
  if(!allowed){
    const e=new Error(`network host "${host||"unknown"}" is not in the module allowlist`);
    e.code="PERMISSION_DENIED";e.permission="network.fetch";
    throw e;
  }
}

function guard(manifest,name){
  try{assertPermission(manifest,name);}
  catch(e){throw denied(name);}
}

async function doFetch(manifest,url,options={}){
  assertPermission(manifest,"network.fetch");
  assertHostAllowed(manifest,url);
  let parsed;
  try{parsed=new URL(String(url));}catch{const e=new Error("network.fetch requires a valid absolute URL");e.code="MODULE_NETWORK_INVALID";throw e;}
  if(parsed.protocol!=="http:"&&parsed.protocol!=="https:"){const e=new Error("network.fetch only supports http(s)");e.code="MODULE_NETWORK_INVALID";throw e;}
  const method=String(options?.method??"GET").toUpperCase();
  if(method!=="GET"){const e=new Error("network.fetch only supports GET in this Core version");e.code="MODULE_NETWORK_INVALID";throw e;}
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),config.moduleNetworkTimeoutMs);
  try{
    const response=await fetch(parsed,{method:"GET",signal:controller.signal,redirect:"follow"});
    const contentType=(response.headers.get("content-type")??"").split(";")[0].trim();
    const buffer=Buffer.from(await response.arrayBuffer());
    if(options.binary===true){
      const cap=Math.max(config.moduleNetworkMaxBytes,config.moduleNetworkBinaryMaxBytes);
      if(buffer.length>cap){const e=new Error(`binary response exceeds ${cap} bytes`);e.code="MODULE_NETWORK_FAILED";throw e;}
      return {status:response.status,ok:response.ok,content_type:contentType,truncated:false,body_base64:buffer.toString("base64"),bytes:buffer.length};
    }
    const capped=buffer.length>config.moduleNetworkMaxBytes?buffer.subarray(0,config.moduleNetworkMaxBytes):buffer;
    return {status:response.status,ok:response.ok,content_type:contentType,truncated:buffer.length>config.moduleNetworkMaxBytes,body:capped.toString("utf8")};
  }catch(e){
    const err=new Error(`network.fetch failed: ${safeErrorMessage(e)}`);err.code="MODULE_NETWORK_FAILED";
    throw err;
  }finally{clearTimeout(timer);}
}

// Permission Bridge：模块能接触到的唯一能力面。
// 绝不暴露 fs / child_process / process / 数据库对象 / config / 任何 API key。
export function buildBridge(manifest,{registerDynamicTool}){
  const api={};

  if(manifest.permissions.includes("tool.register")){
    api.tools={
      async register(definition,handler){
        guard(manifest,"tool.register");
        if(typeof handler!=="function"){const e=new Error("companion.tools.register requires a handler function");e.code="MODULE_TOOL_INVALID";throw e;}
        if(!definition||typeof definition!=="object"||!isValidToolName(definition?.name)){const e=new Error("invalid tool definition name");e.code="MODULE_TOOL_INVALID";throw e;}
        if(PROTECTED_TOOL_NAMES.has(definition.name)){const e=new Error(`tool name "${definition.name}" is protected by Companion Core and cannot be registered by modules`);e.code="TOOL_NAME_PROTECTED";throw e;}
        return registerDynamicTool({
          name:definition.name,
          description:typeof definition.description==="string"?definition.description.trim().slice(0,500):"",
          parameters:definition.parameters&&typeof definition.parameters==="object"&&!Array.isArray(definition.parameters)?definition.parameters:{type:"object",properties:{}}
        },handler);
      }
    };
  }

  if(manifest.permissions.includes("memory.read")){
    api.memory={
      async search(query,limit=5){
        guard(manifest,"memory.read");
        const q=String(query??"").trim();
        if(!q)return [];
        const n=Math.max(1,Math.min(20,Number(limit)||5));
        const rows=await retrieveMemories(config.defaultPersonaId,q,n);
        return rows.map(m=>({content:String(m.content??"").slice(0,500),type:m.type,importance:Number(m.importance)||0,pinned:Boolean(m.pinned)}));
      }
    };
  }

  if(manifest.permissions.includes("events.read")){
    api.events={
      list(limit=20){
        guard(manifest,"events.read");
        const n=Math.max(1,Math.min(100,Number(limit)||20));
        return listRecentEvents(config.defaultPersonaId,n).map(e=>({content:String(e.content??"").slice(0,500),importance:Number(e.importance)||0,created_at:e.created_at}));
      }
    };
  }

  if(manifest.permissions.includes("network.fetch")){
    api.network={
      async fetch(url,options={}){return doFetch(manifest,url,options);},
      async post(url,{contentType="application/json",body=""}={}){
        guard(manifest,"network.fetch");
        assertHostAllowed(manifest,url);
        let parsed;
        try{parsed=new URL(String(url));}catch{const e=new Error("network.post requires a valid absolute URL");e.code="MODULE_NETWORK_INVALID";throw e;}
        if(parsed.protocol!=="http:"&&parsed.protocol!=="https:"){const e=new Error("network.post only supports http(s)");e.code="MODULE_NETWORK_INVALID";throw e;}
        const payload=String(body??"");
        if(payload.length>1024*1024){const e=new Error("post body too large");e.code="MODULE_NETWORK_INVALID";throw e;}
        const controller=new AbortController();
        const timer=setTimeout(()=>controller.abort(),config.moduleNetworkTimeoutMs);
        try{
          const response=await fetch(parsed,{method:"POST",signal:controller.signal,headers:{"content-type":String(contentType).split(";")[0]},body:payload});
          const text=await response.text();
          return {status:response.status,ok:response.ok,content_type:(response.headers.get("content-type")??"").split(";")[0].trim(),body:text.slice(0,16384)};
        }catch(e){
          const err=new Error(`network.post failed: ${safeErrorMessage(e)}`);err.code="MODULE_NETWORK_FAILED";
          throw err;
        }finally{clearTimeout(timer);}
      }
    };
  }

  if(manifest.permissions.includes("media.write")){
    api.media={
      save({base64,mime="image/png",width=null,height=null}={}){
        guard(manifest,"media.write");
        const entry=saveMedia({base64,mime,width,height,kind:"module"});
        publishEvent("media.saved",{mediaId:entry.id,mime:entry.mime,bytes:entry.bytes});
        return {mediaId:entry.id,mime:entry.mime,width:entry.width,height:entry.height,bytes:entry.bytes};
      }
    };
  }

  // 未实现的 namespace（memory.write/events.write/filesystem.*/system_prompt.inject/notification.send）
  // 从不挂载到 bridge 上 —— 模块根本接触不到这些能力。

  return api;
}
