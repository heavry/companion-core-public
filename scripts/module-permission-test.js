import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const root=path.resolve(import.meta.dirname,".."),tmp=fs.mkdtempSync(path.join(os.tmpdir(),"companion-module-perm-"));
process.env.COMPANION_BLOCK_REAL_UPSTREAM="1";
process.env.COMPANION_MODULES_DIR=path.join(tmp,"modules");
process.env.COMPANION_MODULES_STATE_PATH=path.join(tmp,"state.json");
process.env.COMPANION_MODULES_STATE_PATH=path.join(tmp,"state.json");
process.env.DATABASE_PATH=path.join(tmp,"companion.db");
process.env.PERSONA_SYNC_ON_START="true";
process.env.AUTO_PROMOTE_MEMORY="true";
process.env.EMBEDDING_ENABLED="false";
process.env.COMPANION_API_KEY="PERM_TEST_SECRET_KEY_SHOULD_LEAK_NEVER";
process.env.UPSTREAM_PRIMARY_API_KEY="";
process.env.UPSTREAM_BASE_URL="http://127.0.0.1:9/v1";process.env.UPSTREAM_API_KEY="";
process.env.UPSTREAM_SECONDARY_BASE_URL="";process.env.UPSTREAM_SECONDARY_API_KEY="";process.env.UPSTREAM_SECONDARY_MODEL="";
process.env.UPSTREAM_PRIMARY_BASE_URL="";process.env.UPSTREAM_PRIMARY_API_KEY="";
process.env.UPSTREAM_CHAT_BASE_URL="http://127.0.0.1:9/v1";process.env.UPSTREAM_CHAT_API_KEY="";
process.env.UPSTREAM_AGENT_BASE_URL="http://127.0.0.1:9/v1";process.env.UPSTREAM_AGENT_API_KEY="";
process.env.UPSTREAM_SUMMARY_BASE_URL="http://127.0.0.1:9/v1";process.env.UPSTREAM_SUMMARY_API_KEY="";

process.env.UPSTREAM_SECONDARY_BASE_URL="";process.env.UPSTREAM_SECONDARY_API_KEY="";process.env.UPSTREAM_SECONDARY_MODEL="";

const assert=(v,m)=>{if(!v)throw new Error(`ASSERT: ${m}`);};
const localServer=http.createServer((req,res)=>{res.writeHead(200,{"content-type":"application/json"});res.end('{"ok":true}');});
await new Promise(resolve=>localServer.listen(0,"127.0.0.1",resolve));
const localPort=localServer.address().port;
const writeModule=(id,manifest,mainSource)=>{
  const dir=path.join(tmp,"modules",id);
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,"module.json"),JSON.stringify(manifest,null,2));
  fs.writeFileSync(path.join(dir,"main.js"),mainSource);
};
const base=overrides=>({id:"x",name:"X",version:"1",type:"tool",engine:"javascript",permissions:[],tools:[],hooks:[],triggers:[],...overrides});

try{
  const {moduleRegistry}=await import("../src/modules/registry.js");
  const {addStagingMemory}=await import("../src/memory.js");

  // 共享 Memory 种子数据
  const seeded=await addStagingMemory({personaId:"yuna",content:"用户喜欢机械键盘",type:"preference",importance:.95,source:"manual"});
  assert(seeded&&seeded.status==="active","seed memory promoted to active");

  // 模块 A：声明 memory.read —— 允许
  writeModule("memreader",base({id:"memreader",permissions:["memory.read"],tools:[
    {name:"mod_mem_search",description:"search",parameters:{type:"object",properties:{query:{type:"string"}},required:["query"]}},
    {name:"mod_introspect",description:"inspect bridge surface",parameters:{type:"object",properties:{}}}
  ]}),
`async function memSearch(args){const rows=await companion.memory.search(args.query,3);return {count:rows.length,firstHit:String(rows[0]?.content??"")};}
function introspect(){return {
  hasNetwork:typeof companion.network,
  hasEventsList:typeof companion.events,
  hasToolsRegister:typeof companion.tools,
  hasMemoryWrite:typeof (companion.memory&&companion.memory.write),
  hasFetch:typeof companion.fetch,
  companionKeys:Object.keys(companion).sort(),
  processType:typeof process,
  requireType:typeof require,
  importMetaType:typeof import_meta,
  globalThisFs:typeof globalThis.fs,
  envAccess:typeof process!=="undefined"?process.env:null
};}
module.exports={tools:{mod_mem_search:memSearch,mod_introspect:introspect}};`);

  // 模块 B：未声明任何权限 —— memory/network 全部拒绝
  writeModule("nomem",base({id:"nomem",permissions:[],tools:[
    {name:"mod_denied_search",description:"should fail",parameters:{type:"object",properties:{}}}
  ]}),
`async function deniedSearch(){
  if(typeof companion.memory==="undefined"||typeof companion.memory.search!=="function")return {denied:true,code:"BRIDGE_ABSENT"};
  try{await companion.memory.search("机械键盘",3);return {denied:false};}
  catch(e){return {denied:true,code:e.code??String(e)};}
}
module.exports={tools:{mod_denied_search:deniedSearch}};`);

  await moduleRegistry.loadAll();

  const searchRaw=await moduleRegistry.executeModuleTool("mod_mem_search",{query:"机械键盘"});
  assert(searchRaw.includes('"count":1')||searchRaw.includes('"count": 1'),"declared memory.read can search shared memory");
  assert(searchRaw.includes("机械键盘"),"declared memory.read returns matching content");

  const introRaw=await moduleRegistry.executeModuleTool("mod_introspect",{});
  const intro=JSON.parse(introRaw);
  assert(intro.hasNetwork==="undefined","network bridge absent without network.fetch declaration");
  assert(intro.hasEventsList==="undefined","events bridge absent without events.read declaration");
  assert(intro.hasMemoryWrite==="undefined","memory.write is deny-by-default even when memory.read granted");
  assert(intro.processType==="undefined","vm context exposes no process object");
  assert(intro.requireType==="undefined","vm context exposes no require");
  assert(intro.globalThisFs==="undefined","vm context exposes no fs");
  assert(!intro.envAccess,"no process.env access path");
  assert(!JSON.stringify(intro.companionKeys??[]).match(/fs|child_process|config|db/i),"bridge never surfaces core internals");

  const deniedRaw=await moduleRegistry.executeModuleTool("mod_denied_search",{});
  assert(deniedRaw.includes('"denied":true'),"undeclared memory.read is denied at runtime");

  // host/domain allowlist：允许声明 host，拒绝同一模块访问未声明 host；全程只用 harmless localhost。
  writeModule("netallow",base({id:"netallow",permissions:["network.fetch"],network_allowlist:["127.0.0.1"],tools:[
    {name:"mod_net_allowed",description:"allowed local fetch",parameters:{type:"object",properties:{}}},
    {name:"mod_net_denied",description:"denied host fetch",parameters:{type:"object",properties:{}}}
  ]}),
`async function allowed(){return companion.network.fetch("http://127.0.0.1:${localPort}/ok");}
async function denied(){try{await companion.network.fetch("http://localhost:${localPort}/blocked");return {denied:false};}catch(e){return {denied:true,code:e.code,permission:e.permission};}}
module.exports={tools:{mod_net_allowed:allowed,mod_net_denied:denied}};`);
  await moduleRegistry.loadAll({rescan:true});
  const allowedNetwork=JSON.parse(await moduleRegistry.executeModuleTool("mod_net_allowed",{}));
  assert(allowedNetwork.ok===true&&allowedNetwork.status===200,"declared allowlist host is reachable");
  const deniedNetwork=JSON.parse(await moduleRegistry.executeModuleTool("mod_net_denied",{}));
  assert(deniedNetwork.denied===true&&deniedNetwork.code==="PERMISSION_DENIED","undeclared host is denied before fetch");

  // 未声明 tool.register 的模块无法动态注册
  writeModule("nodynamic",base({id:"nodynamic",permissions:[],tools:[{name:"mod_try_register",description:"t",parameters:{type:"object",properties:{}}}]}),
`async function tryRegister(){try{await companion.tools.register({name:"mod_rogue",description:"",parameters:{type:"object",properties:{}}},async()=>({}));return {registered:true};}catch(e){return {registered:false,err:String(e)};}}
module.exports={tools:{mod_try_register:tryRegister}};`);
  await moduleRegistry.loadAll({rescan:true});
  const rogueRaw=await moduleRegistry.executeModuleTool("mod_try_register",{});
  assert(rogueRaw.includes('"registered":false'),"undeclared tool.register cannot register");

  // 秘密不可达：整个 runtime 输出与 bridge 面都不含真实 key
  const allStatus=JSON.stringify(moduleRegistry.listStatus());
  assert(!allStatus.includes("PERM_TEST_SECRET_KEY_SHOULD_LEAK_NEVER"),"registry status never contains secrets");

  console.log("\nPASS Module Permission: declared works, undeclared denied, deny-by-default namespaces, no fs/process/require/env exposure, secret isolation");
}catch(e){
  if(e?.code==="ERR_ASSERTION")throw e;
  throw e;
}finally{
  try{localServer.close();}catch{}
  fs.rmSync(tmp,{recursive:true,force:true});
}
