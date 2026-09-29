import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const RC = process.cwd();
const DATA = path.join(process.env.HOME, "Library/Application Support/CompanionCore-experiment-character-runtime");
fs.mkdirSync(DATA, { recursive: true });
const stamp = Date.now();
process.env.DATABASE_PATH = path.join(DATA, `rc-tok-${stamp}.db`);
process.env.COMPANION_INSTANCE_ID_PATH = path.join(DATA, `rc-tok-${stamp}.json`);
process.env.COMPANION_PRIMARY_LOCK_PATH = path.join(DATA, `rc-tok-${stamp}.lock`);
process.env.COMPANION_DEPLOYMENT_ROLE = "development-test";
process.env.COMPANION_CONTEXT_SANITATION_ENABLED = "false";

const { insertMessage, listRecentMessagesAfter, getOrCreateSession } = await import("../src/db.js");
const { upstreamChat } = await import("../src/upstream.js");
const { personaSystem } = await import("../src/context.js");
const { loadPersonaFile } = await import("../src/persona.js");
const { NATURAL_MESSAGING_SYSTEM } = await import("../src/natural-messaging.js");
const { firstPersonReasoningBlock } = await import("../src/character-runtime-v1.js");
const persona = loadPersonaFile();
function sha8(s){return crypto.createHash("sha256").update(String(s??"")).digest("hex").slice(0,8);}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

const TURNS = ["宝宝亲一个","想你了","好好好姐姐我错了","嗯","哈哈好累，顺便问下 HTTP 和 HTTPS 区别是啥"];
const outDir=path.join(RC,"diagnostics/rc-fpr");
fs.mkdirSync(outDir,{recursive:true});

async function runArm(arm){
  const fpr = arm==="R";
  process.env.COMPANION_FIRST_PERSON_REASONING_ENABLED = fpr?"true":"false";
  // config is cached — build messages manually with/without FPR block
  const session = getOrCreateSession("chat", `rc-tok-${arm}-${Date.now()}`, persona.id);
  const rows=[];
  for (const text of TURNS){
    insertMessage(session.id,"chat",{role:"user",content:text});
    const stored=listRecentMessagesAfter(session.id,0,24);
    const hist=stored.map(r=>{
      let content=r.content_text??"";
      try{const p=JSON.parse(r.content_json??"null"); if(p&&typeof p==="object"&&typeof p.text==="string") content=p.text;}catch{}
      const out={role:r.role,content};
      if(r.reasoning) out.reasoning_content=r.reasoning;
      return out;
    });
    const messages=[
      {role:"system",content:NATURAL_MESSAGING_SYSTEM},
      {role:"system",content:personaSystem(persona,"chat")},
      ...hist,
      {role:"user",content:text},
      ...(fpr?[{role:"system",content:firstPersonReasoningBlock()}]:[])
    ];
    const fprIn=messages.some(m=>m.role==="system"&&String(m.content).includes("第一人称理解"));
    const started=Date.now();
    const up=await upstreamChat({stream:false,temperature:0.9,max_tokens:220},messages,"chat",AbortSignal.timeout(90000),{});
    const latency=Date.now()-started;
    if(!up.ok){
      rows.push({arm,text,error:`http_${up.status}`,latency,fpr_in_prompt:fprIn});
      console.log(arm,"ERR",text.slice(0,12),up.status);
      await sleep(1200);
      continue;
    }
    const data=await up.json();
    const msg=data?.choices?.[0]?.message??{};
    const reasoning=typeof msg.reasoning_content==="string"?msg.reasoning_content:typeof msg.reasoning==="string"?msg.reasoning:null;
    insertMessage(session.id,"chat",{role:"assistant",content:msg.content??"",reasoning_content:reasoning??undefined});
    const after=listRecentMessagesAfter(session.id,0,24);
    const histR=after.filter(x=>x.reasoning_content||x.reasoning).length;
    rows.push({
      arm, text, fpr_in_prompt:fprIn, latency_ms:latency,
      prompt_tokens:data?.usage?.prompt_tokens??null,
      completion_tokens:data?.usage?.completion_tokens??null,
      reasoning_tokens:data?.usage?.completion_tokens_details?.reasoning_tokens??null,
      reasoning_present:Boolean(reasoning),
      reasoning_chars:reasoning?reasoning.length:0,
      reasoning_sha8:reasoning?sha8(reasoning):null,
      persisted_hist_reasoning_count:histR,
      preview:String(msg.content??"").slice(0,50)
    });
    console.log(arm,"ok",text.slice(0,12),"tok",data?.usage?.prompt_tokens,"lat",latency,"r",reasoning?reasoning.length:0,"histR",histR);
    await sleep(700);
  }
  return rows;
}

const A = await runArm("A"); // FPR off
const R = await runArm("R"); // FPR on
const live=r=>r.filter(x=>!x.error);
const avg=(a,k)=>{const v=a.map(x=>x[k]).filter(x=>typeof x==="number");return v.length?Math.round(v.reduce((s,x)=>s+x,0)/v.length):null;};
const summary={
  fpr_off:{n:live(A).length,avg_prompt:avg(live(A),"prompt_tokens"),avg_completion:avg(live(A),"completion_tokens"),avg_latency:avg(live(A),"latency_ms"),avg_reasoning_chars:avg(live(A),"reasoning_chars"),all_reasoning:live(A).every(x=>x.reasoning_present)},
  fpr_on:{n:live(R).length,avg_prompt:avg(live(R),"prompt_tokens"),avg_completion:avg(live(R),"completion_tokens"),avg_latency:avg(live(R),"latency_ms"),avg_reasoning_chars:avg(live(R),"reasoning_chars"),all_reasoning:live(R).every(x=>x.reasoning_present),all_fpr_in_prompt:live(R).every(x=>x.fpr_in_prompt)},
  delta_prompt_tokens: (avg(live(R),"prompt_tokens")??0)-(avg(live(A),"prompt_tokens")??0),
  delta_latency_ms: (avg(live(R),"latency_ms")??0)-(avg(live(A),"latency_ms")??0),
  rows:[...A,...R]
};
fs.writeFileSync(path.join(outDir,"token-compare.json"),JSON.stringify(summary,null,2));
console.log(JSON.stringify({done:true,fpr_off:summary.fpr_off,fpr_on:summary.fpr_on,delta_prompt_tokens:summary.delta_prompt_tokens,delta_latency_ms:summary.delta_latency_ms},null,2));
