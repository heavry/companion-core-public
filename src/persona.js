import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { getPersona, upsertPersona } from "./db.js";

function needObject(v,name){if(!v||typeof v!=="object"||Array.isArray(v))throw new Error(`${name} 必须是对象`);}
function needString(v,name){if(typeof v!=="string"||!v.trim())throw new Error(`${name} 必须是非空字符串`);}
function exactKeys(v,allowed,name){for(const k of Object.keys(v))if(!allowed.includes(k))throw new Error(`${name}.${k} 不是允许的 Persona 字段`);}

export function validatePersona(p) {
  needObject(p,"persona");
  exactKeys(p,["id","name","version","core_identity","personality","speaking_style","mode_instructions","memory"],"persona");
  needString(p.id,"persona.id"); needString(p.name,"persona.name"); needString(p.core_identity,"persona.core_identity");
  if(!Array.isArray(p.personality)||!p.personality.every(x=>typeof x==="string"))throw new Error("persona.personality 必须是字符串数组");
  needObject(p.speaking_style,"persona.speaking_style");exactKeys(p.speaking_style,["tone","verbosity","emoji_frequency","rules"],"persona.speaking_style");needString(p.speaking_style.tone,"persona.speaking_style.tone");needString(p.speaking_style.verbosity,"persona.speaking_style.verbosity");needString(p.speaking_style.emoji_frequency,"persona.speaking_style.emoji_frequency");
  if(!Array.isArray(p.speaking_style.rules))throw new Error("persona.speaking_style.rules 必须是数组");
  needObject(p.mode_instructions,"persona.mode_instructions");exactKeys(p.mode_instructions,["chat","agent","summary"],"persona.mode_instructions");needString(p.mode_instructions.chat,"mode_instructions.chat");needString(p.mode_instructions.agent,"mode_instructions.agent");needString(p.mode_instructions.summary,"mode_instructions.summary");
  needObject(p.memory,"persona.memory");exactKeys(p.memory,["enabled","chat_retrieval_limit","agent_retrieval_limit"],"persona.memory");
  if(typeof p.memory.enabled!=="boolean")throw new Error("persona.memory.enabled 必须是布尔值");
  for(const k of ["chat_retrieval_limit","agent_retrieval_limit"])if(!Number.isInteger(p.memory[k])||p.memory[k]<0||p.memory[k]>100)throw new Error(`persona.memory.${k} 必须是 0~100 的整数`);
  return p;
}
export function loadPersonaFile(file=path.resolve("./config/persona.json")){ return validatePersona(JSON.parse(fs.readFileSync(file,"utf8"))); }
export function ensureDefaultPersona(){
  const filePersona=loadPersonaFile(); const existing=getPersona(filePersona.id);
  if(!existing||config.personaSyncOnStart)upsertPersona(filePersona);
  return getPersona(filePersona.id)??filePersona;
}
export function requirePersona(id){ const p=getPersona(id); if(!p) throw new Error(`Persona not found: ${id}`); return p; }
