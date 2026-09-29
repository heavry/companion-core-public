import { config } from "./config.js";
import { countSummarizableMessagesAfter,getSession,listSummarizableMessagesAfter,updateSessionSummary,insertEvent,insertUsage } from "./db.js";
import { requirePersona } from "./persona.js";
import { retrieveMemories } from "./memory.js";
import { simpleCompletion,usageUpstreamModel } from "./upstream.js";
import { parseJsonLoose } from "./utils.js";
import { filterSharedMemoryCandidate } from "./memory-policy.js";
import { applyMemoryCandidates,collectWindowCandidates } from "./memory-capture.js";

const queues=new Map(),cooldowns=new Map();
function enqueue(id,fn){const prev=queues.get(id)??Promise.resolve(); const next=prev.catch(()=>{}).then(fn).catch(e=>{cooldowns.set(id,Date.now()+config.summaryRetryCooldownSeconds*1000);console.error(`[summary ${id}]`,e.message??e);}).finally(()=>{if(queues.get(id)===next)queues.delete(id);}); queues.set(id,next);}

export function maybeScheduleSummary(sessionId){
  if((cooldowns.get(sessionId)??0)>Date.now())return;
  enqueue(sessionId,async()=>{
    const s=getSession(sessionId); if(!s)return;
    const count=countSummarizableMessagesAfter(sessionId,s.summary_through_message_id); if(count<config.summaryEveryMessages)return;
    const rows=listSummarizableMessagesAfter(sessionId,s.summary_through_message_id,config.summaryMaxMessages); if(!rows.length)return;
    const p=requirePersona(s.persona_id),isAgent=/agent|opencode|harness|code/i.test(s.source);
    const transcript=rows.map(x=>`[${x.id}] ${x.role}: ${x.content_text.slice(0,isAgent?2500:5000)}`).join("\n");
    const rules=isAgent
      ?"这是代码/Agent Session。共享长期记忆只保存用户长期工作偏好、重要项目决定、最终结果和后续 TODO。严禁保存代码全文、终端日志、tool 输出、临时报错和逐步操作过程。"
      :"这是日常聊天 Session。只保存未来仍有价值的稳定事实、偏好、重要决定、承诺和重要事件，不保存无意义寒暄。不要把助手拒绝了什么写进摘要，也不要记录未说明用途的数字串、误粘贴或一次性测试内容。";
    const previousSummary=s.summary?.trim()?`\n【已有累计摘要】\n${s.summary.trim()}\n请在此基础上更新累计摘要，不要丢失仍然重要的旧信息。`:"";
    const existing=await retrieveMemories(s.persona_id,transcript.slice(-4000),8);
    const existingBlock=existing.length?`\n【已有相关长期记忆】\n${existing.map(m=>`- ${m.content}`).join("\n")}\n不要重复生成语义相同的记忆。`:"";
    // Layer 3：summary/context 压缩前最后一次 memory flush（失败不阻断 summary）
    try{await collectWindowCandidates({rows,personaId:s.persona_id,agent:isAgent,sessionId,source:s.source,phase:"flush"});}catch(e){console.error("[memory flush]",e?.message??e);}
    const completion=await simpleCompletion([
      {role:"system",content:[p.mode_instructions.summary,"你是 Companion Core 后台总结器。只输出 JSON，不要 Markdown。",'{"summary":"更新后的累计中期摘要","memories":[{"content":"...","type":"fact|preference|commitment|event|project|relationship|other","importance":0.0}],"events":[{"content":"...","importance":0.0}]}',rules,`summary 最多 ${config.summaryMaxChars} 个字符；importance 范围 0~1；没有就返回空数组；禁止编造。`,previousSummary,existingBlock].join("\n")},
      {role:"user",content:transcript}
    ]),j=completion.data;
    if(j?.usage)insertUsage({sessionId,source:s.source,publicModel:"summary",upstreamModel:usageUpstreamModel(completion.info),kind:"summary",usage:j.usage});
    const text=j?.choices?.[0]?.message?.content; if(typeof text!=="string")return;
    const out=parseJsonLoose(text),through=rows.at(-1).id;
    let nextSummary=typeof out.summary==="string"?out.summary.trim():(s.summary??"");
    if(nextSummary.length>config.summaryMaxChars)nextSummary=nextSummary.slice(0,config.summaryMaxChars);
    updateSessionSummary(sessionId,nextSummary,through);
    // 日常聊天的自动 Memory 已由 user-only immediate/review/flush 负责，避免把
    // assistant 转述的网页/工具内容经 summary 二次写入。Agent 仍保留经过既有
    // durable/secret policy 的重要项目结果抽取。
    if(isAgent)await applyMemoryCandidates({personaId:s.persona_id,candidates:Array.isArray(out.memories)?out.memories:[],agent:true,source:s.source,sessionId,maxCandidates:12});
    for(const e of Array.isArray(out.events)?out.events.slice(0,8):[]){
      const safe=filterSharedMemoryCandidate({content:e?.content,type:"event",source:s.source,agent:isAgent});
      if(safe.ok&&Number(e.importance??0.5)>=0.55)insertEvent({personaId:s.persona_id,sessionId,source:s.source,content:safe.content,importance:Number(e.importance??0.5)});
    }
    cooldowns.delete(sessionId);
  });
}

export function getWorkerStatus(){return {summary_running:queues.size,summary_cooldowns:[...cooldowns.values()].filter(t=>t>Date.now()).length};}
