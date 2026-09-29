import { normalizeCompatTools } from "./tool-compat.js";

export const PROTECTED_TOOL_NAMES=new Set(["bash","read","write","edit","glob","grep","web_search"]);

export function isValidToolName(name){return typeof name==="string"&&/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name);}

export function buildRequestTools(clientToolsRaw,moduleTools=[]){
  const client=normalizeCompatTools(clientToolsRaw).map(t=>({...t,source:"client",moduleId:null}));
  const seen=new Set(client.map(t=>t.name));
  // 保留调用方已标注的 source（mcp/module），未标注的默认 module。
  const modules=(Array.isArray(moduleTools)?moduleTools:[]).filter(t=>{
    if(!isValidToolName(t?.name)||seen.has(t.name))return false;
    seen.add(t.name);return true;
  }).map(t=>({...t,source:t.source??"module"}));
  return [...client,...modules];
}

export function findRequestTool(tools,name){return (Array.isArray(tools)?tools:[]).find(t=>t?.name===name)??null;}

export function isModuleTool(entry){return entry?.source==="module"&&typeof entry?.moduleId==="string";}

export function isMcpTool(entry){return entry?.source==="mcp"&&typeof entry?.moduleId==="string";}

function capText(text,max){
  if(text.length<=max)return text;
  return `${text.slice(0,max)}\n[module tool output truncated at ${max} chars]`;
}

export function serializeModuleToolResult(value,{maxChars=65536}={}){
  let text;
  if(typeof value==="string")text=value;
  else if(value===undefined||value===null)text="";
  else{try{text=JSON.stringify(value);}catch{text=String(value);}}
  return capText(String(text),Math.max(256,maxChars));
}
