import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const root=fs.mkdtempSync(path.join(os.tmpdir(),"companion-memory-engine-"));
process.env.DATABASE_PATH=path.join(root,"companion.db");process.env.COMPANION_DATA_DIR=root;process.env.EMBEDDING_ENABLED="false";process.env.COMPANION_API_KEY="test-key";
for(const key of ["UPSTREAM_BASE_URL","UPSTREAM_API_KEY","UPSTREAM_CHAT_BASE_URL","UPSTREAM_CHAT_API_KEY","UPSTREAM_CHAT_MODEL","UPSTREAM_AGENT_BASE_URL","UPSTREAM_AGENT_API_KEY","UPSTREAM_AGENT_MODEL","UPSTREAM_SUMMARY_BASE_URL","UPSTREAM_SUMMARY_API_KEY","UPSTREAM_SUMMARY_MODEL","UPSTREAM_PRIMARY_BASE_URL","UPSTREAM_PRIMARY_API_KEY","UPSTREAM_PRIMARY_MODEL","UPSTREAM_SECONDARY_BASE_URL","UPSTREAM_SECONDARY_API_KEY","UPSTREAM_SECONDARY_MODEL","UPSTREAM_SECONDARY_CHAT_BASE_URL","UPSTREAM_SECONDARY_AGENT_BASE_URL","UPSTREAM_SECONDARY_SUMMARY_BASE_URL","TAVILY_API_KEY","TAVILY_BASE_URL","SEARXNG_BASE_URL"])process.env[key]="";
const { insertMemory,updateMemory }=await import("../src/db.js");
const { memoryEngine,LegacyMemoryAdapter,SuzuSelectiveMemoryAdapter }=await import("../src/memory-engine.js");
for(const [content,type,status] of [["用户喜欢乌龙茶","preference","active"],["用户正在完成 Suzu Fusion","project","active"],["旧的旅行计划","event","retired"]]){const row=insertMemory({personaId:"default",content,type,importance:0.8,status:"staging",source:"manual"});updateMemory(row.id,{status});}
const rows=await memoryEngine.retrieve("default","乌龙茶",{limit:2,recordAccess:false});assert.equal(rows[0].representation_layer,"reported");assert.equal(rows[0].subject_role,"user");
const graph=await memoryEngine.graph("default");assert.equal(graph.nodes.length,3);assert.equal(graph.edges.length,0);assert.equal(graph.disclosure.inferredEdges,false);assert.ok(graph.nodes.some(node=>node.temporalState==="historical"));
assert.ok(new LegacyMemoryAdapter());assert.ok(new SuzuSelectiveMemoryAdapter());
fs.rmSync(root,{recursive:true,force:true});console.log("memory-engine-adapter-test: ok");
