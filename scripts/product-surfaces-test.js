import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const root=fs.mkdtempSync(path.join(os.tmpdir(),"companion-product-surfaces-"));
process.env.DATABASE_PATH=path.join(root,"companion.db");process.env.COMPANION_DATA_DIR=root;process.env.COMPANION_STATE_PATH=path.join(root,"state.json");process.env.COMPANION_BEHAVIOR_PATH=path.join(root,"behavior.json");process.env.EMBEDDING_ENABLED="false";process.env.COMPANION_API_KEY="test-key";process.env.DEFAULT_PERSONA_ID="yuna";
for(const key of ["UPSTREAM_BASE_URL","UPSTREAM_API_KEY","UPSTREAM_CHAT_BASE_URL","UPSTREAM_AGENT_BASE_URL","UPSTREAM_SUMMARY_BASE_URL","UPSTREAM_PRIMARY_BASE_URL","UPSTREAM_SECONDARY_BASE_URL","TAVILY_API_KEY","TAVILY_BASE_URL","SEARXNG_BASE_URL"])process.env[key]="";
const { ensureDefaultPersona }=await import("../src/persona.js");ensureDefaultPersona();
const { insertEvent,insertMemory,insertUsage,updateMemory }=await import("../src/db.js");
insertEvent({personaId:"yuna",source:"test",content:"真实事件",importance:0.9});
const memory=insertMemory({personaId:"yuna",content:"用户喜欢乌龙茶",type:"preference",importance:0.8,status:"staging",source:"manual"});updateMemory(memory.id,{status:"active"});
insertUsage({sessionId:null,source:"chat",publicModel:"yuna-chat",upstreamModel:"primary:mock",kind:"chat",usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}});
const { todayProductSnapshot,relationshipProductSnapshot,capabilityProductSnapshot }=await import("../src/product-surfaces.js");
const today=todayProductSnapshot();assert.equal(today.events[0].content,"真实事件");assert.equal(today.usage.requests,1);assert.equal(today.plans.available,true);assert.deepEqual(today.plans.upcoming,[]);assert.ok(Array.isArray(today.proactive.reasons));assert.equal(today.diary.available,true);assert.ok(today.diary.selectedDate);assert.equal(today.diary.entry,null);
const relationship=relationshipProductSnapshot();assert.equal(relationship.persona.id,"yuna");assert.equal(relationship.persona.name,"林小糖");assert.equal(relationship.memoryOverview.active,1);assert.equal(relationship.memoryOverview.recent[0].content,"用户喜欢乌龙茶");assert.equal(relationship.journal.available,false);
const capabilities=capabilityProductSnapshot();assert.equal(capabilities.source,"companion-capability-registry");assert.ok(Array.isArray(capabilities.data));
fs.rmSync(root,{recursive:true,force:true});console.log("product-surfaces-test: ok");
