import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const child=process.argv[2]==="verify",root=child?process.argv[3]:fs.mkdtempSync(path.join(os.tmpdir(),"companion-memory-brain-"));
process.env.DATABASE_PATH=path.join(root,"companion.db");process.env.COMPANION_DATA_DIR=root;process.env.EMBEDDING_ENABLED="false";process.env.COMPANION_API_KEY="test-key";process.env.DEFAULT_PERSONA_ID="yuna";process.env.AUTO_PROMOTE_MEMORY="true";
for(const key of ["UPSTREAM_BASE_URL","UPSTREAM_API_KEY","UPSTREAM_CHAT_BASE_URL","UPSTREAM_CHAT_API_KEY","UPSTREAM_CHAT_MODEL","UPSTREAM_AGENT_BASE_URL","UPSTREAM_AGENT_API_KEY","UPSTREAM_AGENT_MODEL","UPSTREAM_SUMMARY_BASE_URL","UPSTREAM_SUMMARY_API_KEY","UPSTREAM_SUMMARY_MODEL","UPSTREAM_PRIMARY_BASE_URL","UPSTREAM_PRIMARY_API_KEY","UPSTREAM_PRIMARY_MODEL","UPSTREAM_SECONDARY_BASE_URL","UPSTREAM_SECONDARY_API_KEY","UPSTREAM_SECONDARY_MODEL","TAVILY_API_KEY","TAVILY_BASE_URL","SEARXNG_BASE_URL"])process.env[key]="";

const {db,primaryInstanceLease,getMemory,insertMemory,listMemoriesAdmin,updateMemory}=await import("../src/db.js");
if(child){
  const rows=listMemoriesAdmin({personaId:"yuna",status:"all"});
  assert.equal(rows.filter(row=>row.source==="manual"&&row.evidence_mode==="manual").length,2,"manual provenance persists after restart");
  assert.equal(rows.filter(row=>row.status==="active").length,3,"active state persists after restart");
  db.close();process.exit(0);
}

const {memoryEngine,memoryStableLayout,memoryVisualFamily,memoryVisualTier}=await import("../src/memory-engine.js");
const {addManualMemory,inspectManualMemory}=await import("../src/memory.js");
const preference=insertMemory({personaId:"yuna",content:"用户喜欢自然聊天",type:"preference",importance:0.97,status:"active",source:"conversation"});
const fact=insertMemory({personaId:"yuna",content:"Companion 项目使用 SwiftUI",type:"fact",importance:0.45,status:"active",source:"summary"});
const retired=insertMemory({personaId:"yuna",content:"旧的旅行计划",type:"event",importance:0.3,status:"retired",source:"legacy",temporalState:"historical"});

const graph=await memoryEngine.graph("yuna");
assert.equal(graph.edges.length,0,"zero true relations remains zero edges");
assert.equal(graph.disclosure.inferredEdges,false,"no inferred relation disclosure");
assert.equal(graph.nodes.find(node=>node.id===preference.id).visualTier,"major");
assert.equal(graph.nodes.find(node=>node.id===preference.id).visualFamily,"preference");
assert.equal(graph.nodes.find(node=>node.id===retired.id).temporalState,"historical");
assert.deepEqual(memoryStableLayout(preference),memoryStableLayout(preference),"layout is deterministic");
assert.equal(memoryVisualTier(fact),"minor");assert.equal(memoryVisualFamily(fact),"knowledge");

const beforeSearch=listMemoriesAdmin({personaId:"yuna",status:"all"}).map(row=>({id:row.id,access:row.access_count}));
const searched=await memoryEngine.graph("yuna",{search:"SwiftUI"});
assert.equal(searched.search.resultIds[0],fact.id,"server retrieval ranks lexical result");
assert.deepEqual(listMemoriesAdmin({personaId:"yuna",status:"all"}).map(row=>({id:row.id,access:row.access_count})),beforeSearch,"search does not write memory or access metadata");

assert.equal(inspectManualMemory({personaId:"yuna",content:"用户很喜欢自然聊天",type:"preference"}).disposition,"duplicate");
const review=inspectManualMemory({personaId:"yuna",content:"用户更喜欢正式交流",type:"preference"});
assert.equal(review.disposition,"review");assert.equal(review.possibleConflicts[0].id,preference.id);

const created=await addManualMemory({personaId:"yuna",content:"用户正在学习 Memory Brain",type:"project",importance:0.8,temporalState:"planned",keepAlongside:true});
assert.equal(created.outcome,"created");assert.equal(created.memory.source,"manual");assert.equal(created.memory.evidence_mode,"manual");assert.equal(created.memory.temporal_state,"planned");
const duplicate=await addManualMemory({personaId:"yuna",content:"用户正在学习 Memory Brain",type:"project",importance:0.8,temporalState:"planned",keepAlongside:true});
assert.equal(duplicate.outcome,"duplicate");

const replaced=await addManualMemory({personaId:"yuna",content:"用户更喜欢正式交流",type:"preference",importance:0.9,temporalState:"current",replacesId:preference.id});
assert.equal(replaced.outcome,"replaced");assert.equal(getMemory(preference.id).status,"retired");assert.equal(replaced.memory.status,"active");
assert.equal(listMemoriesAdmin({personaId:"yuna",status:"all"}).filter(row=>row.content==="用户正在学习 Memory Brain").length,1,"duplicate does not create a second row");

db.close();
primaryInstanceLease.release(); // A restart must release the prior process lease.
execFileSync(process.execPath,[new URL(import.meta.url).pathname,"verify",root],{stdio:"inherit",env:process.env});
fs.rmSync(root,{recursive:true,force:true});
console.log("memory-brain-product-test: ok");
