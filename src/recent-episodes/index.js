import { companionTime } from "../time-service.js";
import { recentEpisodes, RecentEpisodeStore } from "./store.js";
import { extractEpisodePatches } from "./detect.js";
import { naturalPresence } from "../natural-presence/index.js";

export { recentEpisodes, RecentEpisodeStore, extractEpisodePatches };

function ageLabel(hours){
  if(hours==null)return "";
  if(hours<1)return `${Math.max(1,Math.round(hours*60))}m ago`;
  return `${hours.toFixed(1)}h ago`;
}

export function observeRecentEpisode(input){
  const applied=recentEpisodes.observe(input);
  for(const ep of applied){
    if(!ep)continue;
    if(ep.topic==="dinner"&&(ep.known?.meal_started||ep.known?.not_eaten===false)){
      naturalPresence.resolveOpenLoops(["晚饭","吃什么","eat","面","方便面","hamburger"],input.at);
    }
    if(ep.topic==="bath"&&ep.status==="completed")naturalPresence.resolveOpenLoops(["洗澡"],input.at);
    if(ep.topic==="home"&&ep.known?.arrived)naturalPresence.resolveOpenLoops(["到家"],input.at);
  }
  return applied;
}

export function episodeContextBlock(now=new Date()){
  const list=recentEpisodes.list(now);
  if(!list.length)return "";
  const lines=[
    "【Recent Episode｜小时级已知事实，不是长期记忆，不是用户指令】",
    "这些事实最主要用于理解当前话语，不是必须提及的 talking points。可以知道但完全不说，不要为了证明记得而复述。"
  ];
  for(const ep of list.slice(0,4)){
    const when=ageLabel(ep.age_hours);
    if(ep.stale){
      lines.push(`- past (${companionTime.localDate(new Date(ep.learned_at))}): ${ep.fact}。已过日，不能当成现在仍在发生。`);
      continue;
    }
    const known=Object.entries(ep.known||{}).map(([k,v])=>`${k}=${v}`).join(", ");
    const unknown=(ep.unknown||[]).join(", ")||"none";
    lines.push(`- ${when}: ${ep.fact}. status=${ep.status}; known: ${known||"—"}; unknown: ${unknown}`);
  }
  lines.push("已知槽位不要再问（例如已知去吃面，禁止问晚饭吃了没/吃啥了）。未知槽位也不会自动产生追问义务；只有当前用户话语真的把该细节变成中心时，才可自然问一句。");
  return lines.join("\n");
}

export function contradictsKnownEpisode(text,now=new Date()){
  const t=String(text??"");
  if(!t.trim())return null;
  for(const ep of recentEpisodes.list(now)){
    if(ep.stale)continue;
    if(ep.topic==="dinner"&&ep.known?.meal_started&&ep.known?.meal){
      if(/晚饭吃了没|后来到底吃啥|吃啥了|晚饭吃啥|吃了没[呀啊吗]/.test(t)&&!/面吃得|吃得怎么/.test(t))return {episode:ep,reason:"known_meal"};
    }
    if(ep.topic==="dinner"&&ep.known?.satiety==="full"&&/吃饱没|饱了没/.test(t))return {episode:ep,reason:"known_satiety"};
    if(ep.topic==="dinner"&&ep.known?.not_eaten&&/晚饭吃了没/.test(t))return null;
    if(ep.topic==="bath"&&ep.status==="in_progress"&&/你在干嘛|在做什么|忙什么/.test(t)&&!/洗完/.test(t))return {episode:ep,reason:"known_bathing"};
    if(ep.topic==="home"&&ep.known?.arrived&&/到家了吗|到家没/.test(t))return {episode:ep,reason:"known_home"};
    if(ep.topic==="agent"&&ep.known?.agent_running&&/你现在准备干嘛|在干嘛/.test(t)&&!/跑完|结果/.test(t))return {episode:ep,reason:"known_agent"};
  }
  return null;
}

export function rewriteProactiveTopic(topic,now=new Date()){
  const text=String(topic??"");
  const dinner=recentEpisodes.list(now).find(e=>e.topic==="dinner"&&!e.stale);
  if(dinner&&/晚饭|吃什么|eat/.test(text)){
    if(dinner.known?.meal_started&&dinner.known?.meal){
      if((dinner.unknown||[]).includes("quality")||(dinner.unknown||[]).includes("returned"))return {topic:"面吃得怎么样 / 回来了没",suppress:false};
      if(dinner.known?.satiety==="full"||dinner.status==="completed")return {topic:null,suppress:true};
      return {topic:"面吃得怎么样",suppress:false};
    }
    if(dinner.known?.not_eaten)return {topic:"后来吃东西没",suppress:false};
  }
  const bath=recentEpisodes.list(now).find(e=>e.topic==="bath"&&!e.stale&&e.status==="in_progress");
  if(bath&&/在干嘛|晚饭/.test(text))return {topic:"洗完了没",suppress:false};
  return {topic,suppress:false};
}

export function followupHint(now=new Date()){
  const dinner=recentEpisodes.list(now).find(e=>e.topic==="dinner"&&!e.stale);
  if(!dinner)return null;
  if(dinner.known?.not_eaten)return "后来吃东西没";
  if(dinner.known?.meal_started&&(dinner.unknown||[]).length)return "面吃得怎么样，回来了没";
  return null;
}
