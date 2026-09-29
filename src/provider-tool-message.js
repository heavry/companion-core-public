import crypto from "node:crypto";
import { normalizeCompatTools,validateToolArguments } from "./tool-compat.js";

function fencedBlocks(text){
  const source=String(text??""),lines=source.split(/(?<=\n)/),segments=[];let plain="",fence=null;
  const flush=()=>{if(plain){segments.push({type:"text",raw:plain});plain="";}};
  for(const line of lines){
    const trimmed=line.trim();
    if(!fence&&trimmed.startsWith("```")){
      const language=trimmed.slice(3).trim().toLowerCase();
      if(language===""||language==="json"){flush();fence={raw:line,body:""};continue;}
    }
    if(fence&&trimmed==="```"){fence.raw+=line;segments.push({type:"fence",raw:fence.raw,body:fence.body});fence=null;continue;}
    if(fence){fence.raw+=line;fence.body+=line;}else plain+=line;
  }
  if(fence)plain+=fence.raw;flush();return segments;
}

function decisionFromBlock(body,tools){
  let value;try{value=JSON.parse(String(body??"").trim());}catch{return null;}
  if(!value||typeof value!=="object"||Array.isArray(value))return null;
  const name=String(value.type==="tool_call"?value.name:value.name??""),args=value.arguments;
  if(!name||!args||typeof args!=="object"||Array.isArray(args))return null;
  const tool=tools.find(item=>item.name===name);if(!tool)return {quarantine:true};
  if(validateToolArguments(args,tool.parameters).length)return {quarantine:true};
  const allowed=value.type==="tool_call"?Object.keys(value).every(key=>["type","name","arguments"].includes(key)):Object.keys(value).every(key=>["name","arguments"].includes(key));
  return allowed?{name,args}:null;
}

function collapseExactParagraphRepeats(text){
  const parts=String(text??"").split(/(\n\s*\n)/),out=[];let previous="";
  for(let i=0;i<parts.length;i+=2){const paragraph=parts[i]??"",separator=parts[i+1]??"",key=paragraph.trim();if(key&&key===previous)continue;out.push(paragraph,separator);if(key)previous=key;}
  return out.join("").trim();
}

export function normalizeProviderToolMessage(message,rawTools,{allowRecoveredTools=true,seenText=null}={}){
  const nativeCalls=Array.isArray(message?.tool_calls)?message.tool_calls:[],tools=normalizeCompatTools(rawTools),segments=fencedBlocks(message?.content),calls=[...nativeCalls],kept=[];let quarantined=false;
  if(!nativeCalls.length){
    for(const segment of segments){
      if(segment.type!=="fence"){kept.push(segment.raw);continue;}
      const decision=decisionFromBlock(segment.body,tools);
      if(decision?.name&&allowRecoveredTools){calls.push({id:`call_recovered_${crypto.randomBytes(12).toString("hex")}`,type:"function",function:{name:decision.name,arguments:JSON.stringify(decision.args)}});continue;}
      if(decision?.quarantine||decision?.name){quarantined=true;continue;}
      kept.push(segment.raw);
    }
  }else kept.push(String(message?.content??""));
  let content=collapseExactParagraphRepeats(kept.join(""));
  if(quarantined&&!content)content="工具调用格式无效，未执行。";
  if(content&&seenText?.has(content))content="";else if(content)seenText?.add(content);
  return {...message,content,...(calls.length?{tool_calls:calls}:{tool_calls:undefined})};
}

