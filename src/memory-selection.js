import { config } from "./config.js";
import { conservativeDuplicate } from "./memory-policy.js";
import { compactText,textSimilarity } from "./utils.js";
import { noteAssociationSelection } from "./event-association.js";
import {
  defaultActiveMemory,
  rankByAccessibility,
  scoreMemoryActivation,
  memoryAccessibilityDiagnostics
} from "./memory-accessibility.js";

const LOW_SIGNAL_BIGRAMS=new Set(["什么","怎么","如何","可以","一下","那个","这个","怎样","吗呢","是不是","有没有","告诉","记得","之前","以前","我想","我要","你说","我说"]);
const ANAPHORA_RE=/(?:这个|那个|它|那件事|刚才那个|刚刚那个|还记得|之前说的)/u;
const CURRENT_PURCHASE_QUERY_RE=/(?:现在|目前|当前).{0,8}(?:(?:准备|打算|想|要).{0,4})?(?:买|购买).{0,8}(?:哪个|什么|哪款|哪一款|啥)/u;
const CURRENT_PURCHASE_MEMORY_RE=/(?:用户计划(?:是)?(?:买|购买)|用户当前计划(?:是)?(?:买|购买)|当前计划(?:是)?(?:买|购买)|计划(?:是)?(?:买|购买)|准备买|打算买)/u;

export const memorySelectionDiagnostics={
  candidateCount:0,selectedMemoryCount:0,zeroMemorySelectionCount:0,
  irrelevantInjectionCount:0,duplicateInjectionCount:0,retiredMemoryInjectionCount:0,
  associationCandidateCount:0,selectedAssociationCount:0,irrelevantAssociationCount:0,
  lastCandidateCount:0,lastSelectedCount:0,lastReasons:[]
};

const TRUSTED_ASSOCIATION_TYPES=new Set(["same_entity","same_topic","related_plan","expectation_related"]);
function trustedAssociation(row){
  const association=row?.association;
  return association?.hop===1&&TRUSTED_ASSOCIATION_TYPES.has(association.relation_type)
    &&Number(association.confidence)>=0.85&&Number(association.strength)>=0.7
    &&Boolean(association.evidence_message_id)&&Number(association.activation_score)>=0.55;
}

function queryGrams(query){
  const text=compactText(query);
  const grams=[];
  for(let i=0;i<text.length-1;i++){
    const gram=text.slice(i,i+2);
    if(/[\u4e00-\u9fa5A-Za-z0-9]/u.test(gram)&&!LOW_SIGNAL_BIGRAMS.has(gram))grams.push(gram);
  }
  return [...new Set(grams)];
}

export function memoryRetrievalQuery(query=""){
  const raw=String(query??"");
  return CURRENT_PURCHASE_QUERY_RE.test(raw)?`${raw} 用户计划买`:raw;
}

function currentPurchasePlanMatch(query,memory){
  return CURRENT_PURCHASE_QUERY_RE.test(String(query??""))
    &&memory.status==="active"
    &&memory.temporal_state!=="historical"
    &&CURRENT_PURCHASE_MEMORY_RE.test(String(memory.content??""));
}

function lexicalCoverage(query,memory,focusTopics,allowFocus){
  const content=compactText(memory);
  const grams=queryGrams(query);
  const focused=allowFocus?(focusTopics??[]).flatMap(topic=>queryGrams(topic)).slice(0,8):[];
  const terms=grams.length?grams:[...new Set(focused)];
  if(!terms.length)return 0;
  return terms.filter(term=>content.includes(term)).length/terms.length;
}

function namedFactSlot(memory){
  const text=compactText(memory.content);
  const match=text.match(/^(.{1,36}?)(?:名字是|名叫|叫)(.{1,24})$/u);
  if(!match)return null;
  const subject=match[1].replace(/^(?:用户本人|这个用户|我|用户)/u,"").replace(/的/g,"");
  return subject?`${subject}:name`:null;
}

function duplicateOrSameSlot(a,b){
  if(conservativeDuplicate(a.content,b.content))return true;
  const aSlot=namedFactSlot(a),bSlot=namedFactSlot(b);
  if(aSlot&&bSlot&&aSlot===bSlot)return true;
  return textSimilarity(a.content,b.content)>=0.92;
}

function focusMatch(memory,focusTopics){
  const content=compactText(memory.content);
  return (focusTopics??[]).some(topic=>{
    const terms=queryGrams(topic);
    return terms.some(term=>content.includes(term));
  });
}

function lightRecency(memory){
  const updated=Date.parse(memory.updated_at??memory.created_at??"");
  if(!Number.isFinite(updated))return 0.5;
  const ageDays=Math.max(0,(Date.now()-updated)/86400000);
  return 1/(1+ageDays/90);
}

export function selectMemoriesForGeneration(rows=[],{query="",focusTopics=[],userExplicitRecall=false,max=2,candidateCount=undefined,emotionState=null,activeState=defaultActiveMemory,at=Date.now()}={}){
  const candidates=Array.isArray(rows)?rows:[];
  const allowFocus=ANAPHORA_RE.test(String(query??""));
  const prepared=[];
  for(const row of candidates){
    const memory=row?.memory??row;
    if(!memory?.content)continue;
    if(memory.status&&memory.status!=="active"){
      if(memory.status==="retired")memorySelectionDiagnostics.retiredMemoryInjectionCount++;
      continue;
    }
    if(memory.temporal_state==="historical")continue;
    const lexical=lexicalCoverage(query,memory.content,focusTopics,allowFocus);
    const textScore=Math.max(0,Number(row.text_score)||0);
    const embedding=Math.max(0,Number(row.embedding_score)||0);
    const intentSlot=currentPurchasePlanMatch(query,memory);
    const associationMatch=trustedAssociation(row);
    const associationScore=associationMatch?Math.min(1,Number(row.association.activation_score)):0;
    const relevance=Math.max(lexical,textScore,embedding,intentSlot?0.88:0,associationScore);
    const confidence=Math.max(0,Math.min(1,Number(memory.confidence??0.7)));
    const importance=Math.max(0,Math.min(1,Number(memory.importance)||0));
    const focus=focusMatch(memory,focusTopics)&&allowFocus?1:0;
    // Directional text coverage is normalized by the shorter side. Keep its
    // fallback tolerant of long requests with extra context/tool markers while
    // still requiring concrete overlap; semantic-only candidates stay gated.
    const directMatch=lexical>=0.2||textScore>=0.28||intentSlot||associationMatch;
    const semanticMatch=embedding>=(userExplicitRecall?0.72:0.79);
    if(confidence<0.55&&!userExplicitRecall)continue;
    const requiresCurrentTopicMatch=!allowFocus&&queryGrams(query).length>=2;
    if(requiresCurrentTopicMatch?!directMatch:!(directMatch||semanticMatch))continue;
    const recency=lightRecency(memory);
    // Gate relevance keeps a hard floor; accessibility decides "what surfaces now".
    const score=relevance*0.76+confidence*0.13+importance*0.045+focus*0.035+recency*0.015;
    prepared.push({row,memory,score,relevance,lexical,textScore,embedding,confidence,intentSlot,associationMatch,associationScore});
  }

  // Accessibility ranking among already-relevant candidates (Memory Gate still limits).
  const ranked=rankByAccessibility(prepared.map(item=>({
    ...item.row,
    memory:item.memory,
    selection_score:item.score,
    relevance:item.relevance,
    text_score:item.textScore,
    association:item.associationMatch?item.row.association:null
  })),{query,emotionState,activeState,userExplicitRecall,at,topSource:prepared.some(x=>x.associationMatch)?"association":"retrieval"});

  const preparedByMemory=new Map(prepared.map(item=>[String(item.memory.id),item]));
  const ordered=ranked.map(x=>{
    const base=preparedByMemory.get(String(x.memory.id))??{row:x.row,memory:x.memory,score:x.activation,relevance:0,lexical:0,textScore:0,embedding:0,confidence:Number(x.memory.confidence??0.7),intentSlot:false,associationMatch:Boolean(x.row?.association)};
    return {...base,activation:x.activation,accessibility_score:x.activation};
  });

  const selected=[];
  const limit=Math.max(0,Math.min(2,Number.isFinite(Number(max))?Number(max):2));
  for(const candidate of ordered){
    if(selected.some(item=>duplicateOrSameSlot(candidate.memory,item.memory))){
      memorySelectionDiagnostics.duplicateInjectionCount++;
      continue;
    }
    if(limit===0)break;
    selected.push(candidate);
    if(selected.length>=limit)break;
  }

  const observedCandidateCount=Number.isFinite(Number(candidateCount))?Number(candidateCount):candidates.length;
  const associationRows=candidates.filter(trustedAssociation);
  const eligibleAssociationIds=prepared.filter(item=>item.associationMatch).map(item=>item.memory.id);
  const selectedAssociationIds=selected.filter(item=>item.associationMatch).map(item=>item.memory.id);
  memorySelectionDiagnostics.associationCandidateCount+=associationRows.length;
  memorySelectionDiagnostics.selectedAssociationCount+=selectedAssociationIds.length;
  const eligibleAssociationSet=new Set(eligibleAssociationIds),candidateAssociationSet=new Set(associationRows.map(row=>(row.memory??row).id));
  memorySelectionDiagnostics.irrelevantAssociationCount+=Math.max(0,[...candidateAssociationSet].filter(id=>!eligibleAssociationSet.has(id)).length);
  noteAssociationSelection({candidateIds:[...candidateAssociationSet],eligibleIds:[...eligibleAssociationSet],selectedIds:selectedAssociationIds});
  memorySelectionDiagnostics.irrelevantInjectionCount+=Math.max(0,observedCandidateCount-selected.length);
  memorySelectionDiagnostics.candidateCount+=observedCandidateCount;
  memorySelectionDiagnostics.selectedMemoryCount+=selected.length;
  if(!selected.length)memorySelectionDiagnostics.zeroMemorySelectionCount++;
  memorySelectionDiagnostics.lastCandidateCount=observedCandidateCount;
  memorySelectionDiagnostics.lastSelectedCount=selected.length;
  memorySelectionDiagnostics.lastReasons=selected.map(x=>({id:x.memory.id,score:Number(x.score.toFixed(3)),accessibility:Number((x.activation??x.accessibility_score??0).toFixed(3)),lexical:Number(x.lexical.toFixed(3)),text:Number(x.textScore.toFixed(3)),embedding:Number(x.embedding.toFixed(3)),confidence:Number(x.confidence.toFixed(3)),intent_slot:Boolean(x.intentSlot),association:Boolean(x.associationMatch),activation_score:x.associationMatch?Number(x.row.association.activation_score.toFixed(3)):null}));
  return selected.map(x=>({...x.row,memory:x.memory,selection_score:x.score,accessibility_score:x.activation??x.accessibility_score??0,recall_confidence:x.confidence,in_context:true}));
}

export function resetMemorySelectionDiagnostics(){
  for(const key of ["candidateCount","selectedMemoryCount","zeroMemorySelectionCount","irrelevantInjectionCount","duplicateInjectionCount","retiredMemoryInjectionCount","associationCandidateCount","selectedAssociationCount","irrelevantAssociationCount","lastCandidateCount","lastSelectedCount"])memorySelectionDiagnostics[key]=0;
  memorySelectionDiagnostics.lastReasons=[];
}

export { memoryAccessibilityDiagnostics };
