import vm from "node:vm";
import { config } from "../config.js";

// Trusted Local Module Runtime.
//
// 说明：node:vm 提供独立 V8 context，阻止模块直接触碰 Core 内部对象、fs、
// child_process 与 process.env；但这不是针对恶意代码的加固沙箱。
// 所有真实能力仍必须通过 Permission Bridge（companion.*）并受权限约束。

const CONTEXT_CONSOLE_LIMIT=50;

function sanitizedConsole(sink){
  const push=(level,args)=>sink({level,message:args.map(a=>{
    if(typeof a==="string")return a;
    try{return JSON.stringify(a);}catch{return String(a);}
  }).join(" ").slice(0,500)});
  return {log:(...a)=>push("log",a),warn:(...a)=>push("warn",a),error:(...a)=>push("error",a)};
}

export async function instantiateModule({manifest,source,filename,bridge,moduleConfig=null}){
  const logs=[];
  // 受控定时器：仅 setTimeout/clearTimeout（供模块轮询等合法用途），无 setInterval
  const activeTimers=new Set();
  const safeSetTimeout=(fn,ms,...rest)=>{
    if(typeof fn!=="function")return null;
    const t=setTimeout(()=>{activeTimers.delete(t);fn(...rest);},Math.max(0,Number(ms)||0));
    activeTimers.add(t);
    return t;
  };
  const safeClearTimeout=t=>{if(activeTimers.has(t)){activeTimers.delete(t);clearTimeout(t);}};
  const context=vm.createContext({
    module:{exports:{}},
    exports:{},
    setTimeout:safeSetTimeout,
    clearTimeout:safeClearTimeout,
    console:sanitizedConsole(entry=>{logs.push({...entry,time:new Date().toISOString()});if(logs.length>CONTEXT_CONSOLE_LIMIT)logs.shift();})
  });
  const wrapper=`(function(module,exports,companion,moduleInfo){\n"use strict";\n${source}\n})`;
  let compiled;
  try{compiled=new vm.Script(wrapper,{filename});}
  catch(e){const err=new Error(`module syntax error: ${e.message}`);err.code="MODULE_LOAD_FAILED";throw err;}
  let rawExports;
  try{
    const fn=compiled.runInContext(context,{timeout:config.moduleLoadTimeoutMs});
    rawExports=fn(context.module,context.exports,bridge,{id:manifest.id,name:manifest.name,version:manifest.version,type:manifest.type,permissions:[...manifest.permissions],config:moduleConfig});
  }catch(e){
    if(e?.code==="MODULE_LOAD_FAILED")throw e;
    const err=new Error(`module top-level execution failed: ${e.message}`);err.code="MODULE_LOAD_FAILED";throw err;
  }
  if(!rawExports||typeof rawExports!=="object"){rawExports=context.module.exports??{};}
  return {context,exports:rawExports,logs};
}

export function getHandler(exportsObject,kind,key){
  const bucket=exportsObject?.[kind];
  if(bucket&&typeof bucket==="object"&&!Array.isArray(bucket)){
    const fn=bucket[key];
    if(typeof fn==="function")return fn;
  }
  if(kind==="hooks"&&typeof exportsObject?.[key]==="function")return exportsObject[key];
  return null;
}

function plainJson(value){
  try{return JSON.parse(JSON.stringify(value??null));}
  catch{const e=new Error("module arguments/result are not JSON-serializable");e.code="MODULE_SERIALIZATION_FAILED";throw e;}
}

export async function callModuleHandler(fn,args,{timeoutMs=config.moduleCallTimeoutMs}={}){
  const input=plainJson(args);
  let promise;
  try{promise=Promise.resolve(fn(input));}
  catch(e){return {ok:false,error:e};}
  let result;
  try{result=await Promise.race([
    promise,
    new Promise((_,reject)=>setTimeout(()=>reject(Object.assign(new Error(`module handler timed out after ${timeoutMs}ms`),{code:"MODULE_TIMEOUT"})),timeoutMs))
  ]);}
  catch(e){return {ok:false,error:e};}
  return {ok:true,value:plainJson(result)};
}

export async function callHook(hook,args){
  const outcome=await callModuleHandler(hook,args);
  if(outcome.ok)return outcome;
  const err=outcome.error?.code==="MODULE_TIMEOUT"?outcome.error:new Error(`module hook failed: ${outcome.error?.message??outcome.error}`);
  err.code=outcome.error?.code??"MODULE_HOOK_FAILED";
  throw err;
}
