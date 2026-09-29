import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NaturalPresenceStore,heuristicEvaluation } from "../src/natural-presence/store.js";

const root=fs.mkdtempSync(path.join(os.tmpdir(),"companion-emotion-40-"));
const start=Date.parse("2026-09-23T08:00:00Z");
const scenarios=[
  {name:"calm_baseline",steps:[[0,"嗨"],[1,"我刚吃完饭"],[2,"今天随便聊聊"],[3,"你看过那只猫吗"]]},
  {name:"repeated_dismissal",steps:[[0,"嗯"],[1,"哦"],[2,"随便"],[3,"在吗"]]},
  {name:"expectation_violation",steps:[[0,"我晚上回来找你"],[1,"我先忙一下"],[24*60,"我回来了"],[24*60+1,"聊点别的吧"]]},
  {name:"reinforcement",steps:[[0,"嗯"],[1,"哦"],[2,"随便"],[3,"都行"]]},
  {name:"repair",steps:[[0,"你有病吧"],[1,"对不起，刚才我说重了"],[2,"我不是故意的，下次会认真回你"],[3,"在吗"]]},
  {name:"angry_to_hurt",steps:[[0,"你有病吧"],[1,"讨厌你"],[2,"在吗"],[3,"我错了"]]},
  {name:"excited",steps:[[0,"好消息，我的项目成功了"],[1,"真的搞定了"],[2,"我现在还想笑"],[5*60,"对了，今天吃什么"]]},
  {name:"topic_shift",steps:[[0,"你有病吧"],[1,"楼下有只猫"],[2,"它在晒太阳"],[3,"你说它在想什么"]]},
  {name:"natural_recovery",steps:[[0,"你有病吧"],[24*60,"今天聊点别的"],[3*24*60,"我去喝水"],[5*24*60,"回来了"]]},
  {name:"ordinary",steps:[[0,"今天有点困"],[1,"我去倒杯水"],[2,"回来了"],[3,"外面下雨了"]]}
];
const rows=[];
try{
  for(const scenario of scenarios){
    const file=path.join(root,`${scenario.name}.json`);
    let clock=new Date(start);
    const store=new NaturalPresenceStore({file,enabled:true,now:()=>clock});
    const prior=[];
    for(const [minute,text] of scenario.steps){
      clock=new Date(start+minute*60000);
      const before=store.document.emotion_state?structuredClone(store.document.emotion_state):null;
      const result=store.appraiseUserEmotion({text,messageId:`${scenario.name}:${minute}`,at:clock,recentUserTexts:prior});
      store.applyEvents(heuristicEvaluation(text).events,clock);
      const after=store.document.emotion_state?structuredClone(store.document.emotion_state):null;
      rows.push({scenario:scenario.name,minute,user:text,event:result?.appraisal?.event??null,
        before:before?{primary:before.primary,intensity:before.intensity}:null,
        after:after?{primary:after.primary,intensity:after.intensity,cause_count:after.causes?.length??0}:null});
      prior.push(text);
    }
  }
  assert.equal(rows.length,40);
  const at=(name,index)=>rows.filter(row=>row.scenario===name)[index];
  assert(rows.filter(row=>row.scenario==="calm_baseline").every(row=>row.after===null));
  assert.equal(at("repeated_dismissal",0).after,null);
  assert.equal(at("repeated_dismissal",1).after.primary,"annoyed");
  assert.equal(at("expectation_violation",2).after.primary,"hurt");
  assert.equal(at("expectation_violation",3).after.primary,"hurt");
  assert(at("reinforcement",2).after.intensity>at("reinforcement",1).after.intensity);
  assert(at("repair",2).after.intensity<at("repair",0).after.intensity&&at("repair",2).after!==null);
  assert.equal(at("angry_to_hurt",1).after.primary,"hurt");
  assert.equal(at("excited",0).after.primary,"excited");
  assert.equal(at("topic_shift",3).after.primary,"angry");
  assert.equal(at("natural_recovery",3).after,null);
  assert(rows.filter(row=>row.scenario==="ordinary").every(row=>row.after===null));
  const emotional=rows.filter(row=>row.after);
  const instantResets=rows.filter(row=>row.before?.intensity>=0.4&&row.after===null&&row.event==="ordinary").length;
  const result={kind:"deterministic_state_only_not_model_outputs",turns:40,nonbaseline:emotional.length,
    cause_attached_rate:emotional.length?emotional.filter(row=>row.after.cause_count>0).length/emotional.length:0,
    instant_reset_count:instantResets,rows};
  const output=path.resolve(process.argv[2]??"./diagnostics/emotion-causality/state-40.json");
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(result,null,2));
  console.log(JSON.stringify({output,turns:result.turns,nonbaseline:result.nonbaseline,cause_attached_rate:result.cause_attached_rate,instant_reset_count:result.instant_reset_count}));
}finally{fs.rmSync(root,{recursive:true,force:true});}
