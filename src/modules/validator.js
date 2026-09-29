import { PERMISSION_NAMES } from "./permissions.js";

export const MODULE_TYPES=new Set(["tool","automation","integration"]);
export const MODULE_ENGINES=new Set(["javascript"]);
export const TRIGGER_TYPES=new Set(["manual","interval","event_created"]);
export const HOOK_NAMES=new Set(["onLoad","onUnload"]);

const ID_PATTERN=/^[a-z][a-z0-9_-]{0,63}$/;

function fail(message){const e=new Error(`invalid module manifest: ${message}`);e.code="MODULE_MANIFEST_INVALID";throw e;}

function needString(value,field,max=200){
  if(typeof value!=="string"||!value.trim())fail(`${field} must be a non-empty string`);
  if(value.length>max)fail(`${field} exceeds ${max} chars`);
  return value.trim();
}

function validateToolEntry(entry,index){
  if(!entry||typeof entry!=="object"||Array.isArray(entry))fail(`tools[${index}] must be an object`);
  const name=entry.name;
  if(typeof name!=="string"||!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name))fail(`tools[${index}].name is not a valid tool name`);
  const description=typeof entry.description==="string"?entry.description.trim():"";
  // 未来幂等协作预留：第三方 API 自带幂等键的模块可声明 idempotent；本版行为一律 at-most-once
  const SIDE_EFFECT_LEVELS=new Set(["none","idempotent","non_idempotent"]);
  if(entry.sideEffect!==undefined&&!SIDE_EFFECT_LEVELS.has(entry.sideEffect))fail(`tools[${index}].sideEffect must be one of ${[...SIDE_EFFECT_LEVELS].join("|")}`);
  const sideEffect=entry.sideEffect??"non_idempotent";
  const parameters=entry.parameters&&typeof entry.parameters==="object"&&!Array.isArray(entry.parameters)?entry.parameters:{type:"object",properties:{}};
  if(parameters.type!=="object")fail(`tools[${index}].parameters.type must be "object"`);
  if(parameters.properties!==undefined&&(typeof parameters.properties!=="object"||Array.isArray(parameters.properties)||parameters.properties===null))fail(`tools[${index}].parameters.properties must be an object`);
  return {name,description,parameters,sideEffect};
}

function validateTriggerEntry(entry,index){
  if(!entry||typeof entry!=="object"||Array.isArray(entry))fail(`triggers[${index}] must be an object`);
  const id=needString(entry.id,`triggers[${index}].id`,100);
  if(!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(id))fail(`triggers[${index}].id is not a valid identifier`);
  if(!TRIGGER_TYPES.has(entry.type))fail(`triggers[${index}].type must be one of ${[...TRIGGER_TYPES].join("|")}`);
  const out={id,type:entry.type,config:entry.config&&typeof entry.config==="object"&&!Array.isArray(entry.config)?entry.config:{}};
  if(entry.type==="interval"){
    const seconds=Number(entry.everySeconds);
    if(!Number.isFinite(seconds)||seconds<1)fail(`triggers[${index}].everySeconds must be a number >= 1 for interval triggers`);
    out.everySeconds=Math.floor(seconds);
  }
  return out;
}

export function validateManifest(raw,{dirName=""}={}){
  if(!raw||typeof raw!=="object"||Array.isArray(raw))fail("manifest must be a JSON object");
  const id=needString(raw.id,"id",64);
  if(!ID_PATTERN.test(id))fail("id must match [a-z][a-z0-9_-]{0,63}");
  if(dirName&&dirName!==id)fail(`directory name "${dirName}" does not match manifest id "${id}"`);
  const name=needString(raw.name,"name");
  const version=needString(raw.version,"version",32);
  if(!MODULE_TYPES.has(raw.type))fail(`type must be one of ${[...MODULE_TYPES].join("|")}`);
  const engine=raw.engine??"javascript";
  if(!MODULE_ENGINES.has(engine))fail(`engine "${engine}" is not supported`);
  if(!Array.isArray(raw.permissions))fail("permissions must be an array");
  for(const p of raw.permissions)if(!PERMISSION_NAMES.has(p))fail(`unknown permission namespace: ${String(p)}`);
  if(new Set(raw.permissions).size!==raw.permissions.length)fail("duplicate permission entries are not allowed");
  if(raw.network_allowlist!==undefined&&!Array.isArray(raw.network_allowlist))fail("network_allowlist must be an array");
  const networkAllowlist=(raw.network_allowlist??[]).map((value,index)=>{
    const host=needString(value,`network_allowlist[${index}]`,253).toLowerCase().replace(/^www\./,"");
    if(host!=="localhost"&&!/^(?:\d{1,3}(?:\.\d{1,3}){3}|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$/.test(host))fail(`network_allowlist[${index}] must be a host/domain without scheme or path`);
    if(host.includes(".."))fail(`network_allowlist[${index}] contains an invalid hostname`);
    return host;
  });
  if(new Set(networkAllowlist).size!==networkAllowlist.length)fail("duplicate network_allowlist entries are not allowed");
  if(!Array.isArray(raw.tools))fail("tools must be an array");
  const tools=raw.tools.map(validateToolEntry);
  if(new Set(tools.map(t=>t.name)).size!==tools.length)fail("duplicate tool names in manifest are not allowed");
  if(!Array.isArray(raw.hooks??[]))fail("hooks must be an array");
  for(const hook of raw.hooks??[])if(!HOOK_NAMES.has(hook))fail(`unknown hook: ${String(hook)} (supported: ${[...HOOK_NAMES].join("|")})`);
  if(!Array.isArray(raw.triggers??[]))fail("triggers must be an array");
  const triggers=(raw.triggers??[]).map(validateTriggerEntry);
  if(new Set(triggers.map(t=>t.id)).size!==triggers.length)fail("duplicate trigger ids in manifest are not allowed");
  return {
    id,name,version,
    type:raw.type,
    engine,
    description:typeof raw.description==="string"?raw.description.trim().slice(0,500):"",
    permissions:[...new Set(raw.permissions)],
    network_allowlist:networkAllowlist,
    tools,
    hooks:[...new Set(raw.hooks??[])],
    triggers
  };
}
