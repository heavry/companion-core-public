import { config } from "../config.js";
import { requirePersona } from "../persona.js";
import { upstreamChat } from "../upstream.js";
import { insertUsage } from "../db.js";
import { createOpenLoopCompletionEvent,createOpenLoopEvents } from "../event-association.js";
import { usageUpstreamModel,upstreamResponseInfo } from "../upstream.js";
import {
  naturalPresence,parsePresenceEvaluation,presenceEvaluationPrompt,heuristicEvaluation,
  EVENT_DELTAS,DIMENSIONS
} from "./store.js";

export { naturalPresence,EVENT_DELTAS,DIMENSIONS,parsePresenceEvaluation,heuristicEvaluation };

/**
 * LLM labels what happened; code applies numeric deltas.
 * Falls back to heuristics when upstream/JSON fails.
 */
export async function evaluateAndApplyTurn({userText="",assistantText="",sessionId=null,sourceMessageId=null,at=new Date(),useLlm=true}={}){
  if(!naturalPresence.enabled)return {ok:false,reason:"disabled"};
  let evaluation={ok:false,...heuristicEvaluation(userText,assistantText)};
  if(useLlm&&config.naturalPresenceEnabled){
    try{
      const persona=requirePersona(config.defaultPersonaId);
      const opinion=naturalPresence.document.opinions?.[0]??null;
      const messages=[
        {role:"system",content:[persona.mode_instructions.chat,"你是内部事件标注器，不是聊天对象。"].join("\n")},
        {role:"user",content:presenceEvaluationPrompt({userText,assistantText,existingOpinion:opinion})}
      ];
      const up=await upstreamChat({stream:false,temperature:0.1,max_tokens:400},messages,"chat",AbortSignal.timeout(config.naturalPresenceEventModelTimeoutMs),{});
      if(up.ok){
        const data=await up.json();
        if(data?.usage)insertUsage({sessionId,source:"presence",publicModel:"presence",upstreamModel:usageUpstreamModel(upstreamResponseInfo(up)),kind:"presence",usage:data.usage});
        const parsed=parsePresenceEvaluation(data?.choices?.[0]?.message?.content);
        if(parsed.ok&&(parsed.events.length||parsed.open_loops.length||parsed.thought_seeds.length||parsed.opinion))evaluation={ok:true,...parsed,via:"llm"};
      }
    }catch{
      evaluation={ok:false,...heuristicEvaluation(userText,assistantText),via:"heuristic_fallback"};
    }
  }
  // A slow evaluator from an older turn must not rewrite the current state.
  if(Date.parse(naturalPresence.document.last_emotion_user_at??"")>new Date(at).getTime()){
    return {ok:false,reason:"stale_turn_evaluation"};
  }
  const applied=naturalPresence.applyEvents(evaluation.events,at);
  const openLoopsBefore=new Map((naturalPresence.document.open_loops??[]).map(loop=>[loop.id,structuredClone(loop)]));
  const assistantAnswered=/我听着了|明白了|懂了|还惦记着|慢慢攒|心是到了|本地是更私密|亲一下|去吧|晚安/.test(String(assistantText??""))
    &&String(assistantText??"").trim().length>=8;
  if(evaluation.open_loops?.length){
    naturalPresence.upsertOpenLoops(evaluation.open_loops,at,{
      userText,assistantText,assistantAnswered,sourceMessageId
    });
  }
  if(evaluation.thought_seeds?.length)naturalPresence.addThoughtSeeds(evaluation.thought_seeds,at);
  if(evaluation.opinion)naturalPresence.noteOpinion({...evaluation.opinion,at});
  // resolve loops if user text clearly closes them；同时 reconcile ownership after full turn
  const completionUser=/跑完了|弄好了|搞定了|结束了|完成了|不用了/.test(String(userText??""));
  naturalPresence.resolveOpenLoops(
    completionUser?[String(userText).slice(0,40)]:[],
    at,
    {userText,assistantText}
  );
  if(sourceMessageId){
    const currentLoops=naturalPresence.document.open_loops??[];
    const completed=currentLoops.filter(loop=>!openLoopsBefore.get(loop.id)?.resolved&&loop.resolved);
    for(const loop of completed)createOpenLoopCompletionEvent({personaId:config.defaultPersonaId,sessionId,sourceMessageId,text:userText,topic:loop.topic});
    createOpenLoopEvents({personaId:config.defaultPersonaId,sessionId,sourceMessageId,text:userText,
      loops:currentLoops.filter(loop=>String(loop.source_message_id??"")===String(sourceMessageId))});
  }
  return {ok:true,via:evaluation.via??"heuristic",events:applied.applied,evaluation,snapshot:naturalPresence.snapshot({advance:false})};
}

export function presenceContext(at=new Date(),continuity=null){
  if(!naturalPresence.enabled)return "";
  return naturalPresence.contextBlock(at,continuity);
}

export function decideContact(input){
  const decision=naturalPresence.contactDecision(input);
  naturalPresence.noteContactDecision(decision);
  return decision;
}
