const HOUR_MS=3600_000;

export function ttlHoursFor(topic){
  return {dinner:20,bath:3,agent:12,home:6,game:4,sleep:10,download:8,shopping:6,exam:12}[topic]??6;
}

export function extractEpisodePatches(text="",{role="user"}={}){
  const t=String(text??"").trim();
  if(!t)return [];
  const patches=[];

  if(/出去吃面|去吃面|在吃面|吃面了|吃的面/.test(t)){
    patches.push({topic:"dinner",fact:"用户出去吃面",status:"in_progress",known:{meal:"noodles",meal_started:true},unknown:["quality","returned"],ttlHours:ttlHoursFor("dinner")});
  }else if(/没吃晚饭|还没吃饭|没吃饭/.test(t)){
    patches.push({topic:"dinner",fact:"用户还没吃晚饭",status:"unknown",known:{meal_started:false,not_eaten:true},unknown:["later_ate"],ttlHours:ttlHoursFor("dinner")});
  }else if(/点了饭|点了外卖|改点饭|没去.{0,6}点了/.test(t)){
    patches.push({topic:"dinner",fact:"用户点了饭",status:"in_progress",known:{meal:"rice_or_takeout",meal_started:true},unknown:["quality","satiety"],ttlHours:ttlHoursFor("dinner"),replace:true});
  }

  if(role==="user"&&/吃饱了|挺饱|吃好了|吃完了/.test(t)){
    patches.push({topic:"dinner",merge:true,status:"completed",known:{satiety:"full",meal_completed:true},unknownRemove:["satiety","quality"]});
  }

  if(/去洗澡|在洗澡|洗澡了/.test(t)&&!/洗完/.test(t)){
    patches.push({topic:"bath",fact:"用户去洗澡了",status:"in_progress",known:{bathing:true},unknown:["finished"],ttlHours:ttlHoursFor("bath")});
  }
  if(/洗完了|洗好了/.test(t)){
    patches.push({topic:"bath",merge:true,status:"completed",known:{bathing:false,finished:true},unknownRemove:["finished"]});
  }

  if(/去跑\s*agent|跑\s*agent|agent.{0,8}一会回来/i.test(t)){
    patches.push({topic:"agent",fact:"用户去跑 Agent",status:"in_progress",known:{agent_running:true},unknown:["result"],ttlHours:ttlHoursFor("agent")});
  }
  if(/刚到家|到家了|回来了/.test(t)&&!/回来就跟我说/.test(t)){
    patches.push({topic:"home",fact:"用户刚到家",status:"completed",known:{arrived:true},unknown:[],ttlHours:ttlHoursFor("home")});
    patches.push({topic:"dinner",merge:true,known:{returned:true},unknownRemove:["returned"]});
  }

  if(/去睡觉|困了.*睡|睡觉了/.test(t)){
    patches.push({topic:"sleep",fact:"用户去睡觉了",status:"in_progress",known:{sleeping:true},unknown:[],ttlHours:ttlHoursFor("sleep")});
  }
  if(/在打游戏|去玩游戏|玩一会/.test(t)){
    patches.push({topic:"game",fact:"用户在打游戏",status:"in_progress",known:{gaming:true},unknown:[],ttlHours:ttlHoursFor("game")});
  }
  if(/正在下载|在下载模型/.test(t)){
    patches.push({topic:"download",fact:"用户正在下载",status:"in_progress",known:{downloading:true},unknown:["finished"],ttlHours:ttlHoursFor("download")});
  }
  if(/我妈出去买|妈出去买东西/.test(t)){
    patches.push({topic:"shopping",fact:"用户的妈妈出去买东西",status:"in_progress",known:{mom_out:true},unknown:["returned"],ttlHours:ttlHoursFor("shopping")});
  }
  if(/考完了|考试考完/.test(t)){
    patches.push({topic:"exam",fact:"用户刚考完试",status:"completed",known:{exam_done:true},unknown:[],ttlHours:ttlHoursFor("exam")});
  }

  if((/不是.{0,10}火锅/.test(t)&&/面/.test(t))||(/不是/.test(t)&&/吃面|是面/.test(t))){
    patches.push({topic:"dinner",merge:true,replace:true,fact:"用户吃的是面",status:"in_progress",known:{meal:"noodles",meal_started:true},unknown:["quality","satiety"]});
  }
  return patches;
}

export function hoursAgo(isoLike,now=new Date()){
  const t=Date.parse(isoLike??"");
  if(!Number.isFinite(t))return null;
  return Math.max(0,(now.getTime()-t)/HOUR_MS);
}
