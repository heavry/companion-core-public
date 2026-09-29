import fs from "node:fs";
import path from "node:path";
import { analyzeNaturalResponse } from "../src/natural-response-policy.js";

const beforePath=path.resolve(process.argv[2]||"./diagnostics/natural-response-policy/before.json");
const afterPath=path.resolve(process.argv[3]||"./diagnostics/natural-response-policy/after.json");
const outputPath=path.resolve(process.argv[4]||"./diagnostics/natural-response-policy/comparison.md");
const before=JSON.parse(fs.readFileSync(beforePath,"utf8"));
const after=JSON.parse(fs.readFileSync(afterPath,"utf8"));

function analysisFor(row){
  return analyzeNaturalResponse({text:row.assistant,selection:{
    primaryAct:row.policy?.primary_act??null,
    secondaryAct:row.policy?.secondary_act??null,
    contextDisposition:row.policy?.context_disposition??null,
    adviceAllowed:row.policy?.primary_act==="ADVICE",
    closureAllowed:row.policy?.primary_act==="CLOSURE",
    summaryAllowed:false
  }});
}
function scaffold(row,analysis){
  const flags=[];
  if(analysis.currentSituationSummarized)flags.push("SUMMARY");
  if(analysis.adviceGiven)flags.push("ADVICE");
  if(analysis.closureGiven)flags.push("CLOSURE");
  if(/[?？]/.test(row.assistant))flags.push("QUESTION");
  const opener=/^(?:嗯|哦|噢)/.test(row.assistant)?"ACK":/^(?:哈哈|嘻嘻|嘿嘿)/.test(row.assistant)?"LAUGH":/^(?:哎呀|哎哟|哪有|完了)/.test(row.assistant)?"REACT":"PLAIN";
  const length=Array.from(row.assistant).length<=6?"XS":Array.from(row.assistant).length<=16?"S":"L";
  return `${row.bubbles?.length??1}:${opener}:${flags.join("+")||"SINGLE"}:${length}`;
}
function recompute(report){
  const rows=report.turns.filter(row=>row.assistant);
  const analyzed=rows.map(row=>({row,analysis:analysisFor(row)}));
  const ratio=predicate=>rows.length?Number((rows.filter(predicate).length/rows.length).toFixed(3)):0;
  const runs=[];
  for(let i=0;i<analyzed.length;){
    const key=scaffold(analyzed[i].row,analyzed[i].analysis);let j=i+1;
    while(j<analyzed.length&&scaffold(analyzed[j].row,analyzed[j].analysis)===key)j+=1;
    if(j-i>=3)runs.push({structure:key,startTurn:analyzed[i].row.turn,endTurn:analyzed[j-1].row.turn,length:j-i});
    i=j;
  }
  return {
    ...report.summary,
    explicitRecentEventMentionRatio:ratio(row=>(row.eventTerms||[]).some(term=>term&&!String(row.text??"").includes(term)&&row.assistant.includes(term))),
    adviceRatio:rows.length?Number((analyzed.filter(item=>item.analysis.adviceGiven).length/rows.length).toFixed(3)):0,
    closureRatio:rows.length?Number((analyzed.filter(item=>item.analysis.closureGiven).length/rows.length).toFixed(3)):0,
    situationSummaryRatio:rows.length?Number((analyzed.filter(item=>item.analysis.currentSituationSummarized).length/rows.length).toFixed(3)):0,
    consecutiveTemplateRuns:runs
  };
}

const esc=value=>String(value??"").replace(/\|/g,"\\|").replace(/\r?\n/g," / ");
const percent=value=>`${Math.round(Number(value||0)*100)}%`;
const beforeByTurn=new Map(before.turns.map(row=>[row.turn,row]));
const afterByTurn=new Map(after.turns.map(row=>[row.turn,row]));
const pairs=[...beforeByTurn.keys()].filter(turn=>afterByTurn.has(turn)).slice(0,12).map(turn=>({before:beforeByTurn.get(turn),after:afterByTurn.get(turn)}));

const beforeSummary=recompute(before);
const afterMatchedSummary=recompute({...after,turns:pairs.map(pair=>pair.after)});
const afterSummary=recompute(after);
const lines=[
  "# Natural Response Policy — Real Model Before/After",
  "",
  `- Before: ${before.successfulTurns}/${before.turnCount} successful turns`,
  `- After: ${after.successfulTurns}/${after.turnCount} successful turns`,
  `- Before explicit recent-event mention: ${percent(beforeSummary.explicitRecentEventMentionRatio)}`,
  `- After explicit recent-event mention (matched ${pairs.length}): ${percent(afterMatchedSummary.explicitRecentEventMentionRatio)}`,
  `- After explicit recent-event mention (full ${after.successfulTurns}): ${percent(afterSummary.explicitRecentEventMentionRatio)}`,
  `- Before advice: ${percent(beforeSummary.adviceRatio)}`,
  `- After advice (matched ${pairs.length}): ${percent(afterMatchedSummary.adviceRatio)}`,
  `- After advice (full ${after.successfulTurns}): ${percent(afterSummary.adviceRatio)}`,
  `- Before closure: ${percent(beforeSummary.closureRatio)}`,
  `- After closure (matched ${pairs.length}): ${percent(afterMatchedSummary.closureRatio)}`,
  `- After closure (full ${after.successfulTurns}): ${percent(afterSummary.closureRatio)}`,
  `- Before situation summary: ${percent(beforeSummary.situationSummaryRatio)}`,
  `- After situation summary (matched ${pairs.length}): ${percent(afterMatchedSummary.situationSummaryRatio)}`,
  `- After situation summary (full ${after.successfulTurns}): ${percent(afterSummary.situationSummaryRatio)}`,
  `- After selected acts: ${JSON.stringify(afterSummary.selectedActCounts??{})}`,
  `- After realized acts: ${JSON.stringify(afterSummary.realizedActCounts??afterSummary.actCounts??{})}`,
  `- After 3+ identical structures: ${(afterSummary.consecutiveTemplateRuns??[]).length}`,
  "",
  "## Same-turn comparisons",
  "",
  "| Turn | Category | User | Before (real model) | After (real model) | Selected act |",
  "|---:|---|---|---|---|---|",
  ...pairs.map(({before:oldRow,after:newRow})=>`| ${oldRow.turn} | ${esc(oldRow.category)} | ${esc(oldRow.text)} | ${esc(oldRow.assistant||oldRow.error)} | ${esc(newRow.assistant||newRow.error)} | ${esc(newRow.policy?.primary_act||newRow.metrics?.primary)} |`),
  ""
];
fs.mkdirSync(path.dirname(outputPath),{recursive:true});
fs.writeFileSync(outputPath,`${lines.join("\n")}\n`);
console.log(JSON.stringify({outputPath,pairs:pairs.length,before:beforeSummary,afterMatched:afterMatchedSummary,afterFull:afterSummary},null,2));
