import { listMemoriesAdmin } from "./db.js";
import { retrieveMemoriesDetailed } from "./memory.js";

const STATE_TYPES=new Set(["preference","relationship","commitment"]);

function stableUnit(value,salt=""){
  let hash=2166136261;
  for(const ch of `${salt}:${value}`){hash^=ch.charCodeAt(0);hash=Math.imul(hash,16777619);}
  return (hash>>>0)/4294967295;
}

export function memoryVisualFamily(memory){
  return ({preference:"preference",relationship:"relationship",commitment:"intent",project:"project",event:"event",fact:"knowledge",other:"reflection"})[memory.type]??"knowledge";
}

export function memoryVisualTier(memory){
  const importance=Number(memory.importance)||0;
  if(memory.pinned||memory.type==="relationship"||importance>=0.95)return "major";
  if(STATE_TYPES.has(memory.type)||importance>=0.56)return "state";
  return "minor";
}

export function memoryStableLayout(memory){
  const tier=memoryVisualTier(memory),angle=stableUnit(memory.id,"angle")*Math.PI*2;
  const base=tier==="major"?0.2:tier==="state"?0.48:0.76;
  return {angle:Number(angle.toFixed(6)),radius:Number((base+stableUnit(memory.id,"radius")*0.14).toFixed(6)),depth:Number((0.35+stableUnit(memory.id,"depth")*0.65).toFixed(6))};
}

function nodeFromMemory(memory){
  const temporalState=memory.status==="retired"?"historical":(memory.temporal_state??"current");
  const evidenceMode=memory.source==="manual"?"manual":(memory.evidence_mode??"derived");
  return {
    id:memory.id,title:memory.content.slice(0,72),content:memory.content,preview:memory.content.slice(0,180),kind:memory.type,
    stateFamily:STATE_TYPES.has(memory.type)?memory.type:"not_applicable",representationLayer:"reported",temporalState,evidenceMode,
    source:memory.source,status:memory.status,importance:Number(memory.importance),confidence:Number(memory.confidence??0.7),pinned:Boolean(memory.pinned),createdAt:memory.created_at,updatedAt:memory.updated_at,
    visualTier:memoryVisualTier(memory),visualFamily:memoryVisualFamily(memory),layout:memoryStableLayout(memory),
    evidence:[{source:memory.source,mode:evidenceMode,recordedAt:memory.created_at}],relatedMemoryIds:[]
  };
}

export class MemoryEngine{
  async retrieve(){throw new Error("MemoryEngine.retrieve not implemented");}
  async graph(){throw new Error("MemoryEngine.graph not implemented");}
}

export class LegacyMemoryAdapter extends MemoryEngine{
  async retrieve(personaId,query,options={}){return retrieveMemoriesDetailed(personaId,query,options);}
  async graph(personaId,{search="",limit=500}={}){
    const all=listMemoriesAdmin({personaId,status:"all",limit});
    let ordered=all,searchResultIds=[];
    if(search.trim()){
      const ranked=await retrieveMemoriesDetailed(personaId,search,{limit:Math.min(100,limit),recordAccess:false,candidateLimit:Math.min(200,limit)});
      searchResultIds=ranked.filter(row=>row.final_score>0).map(row=>row.memory.id);
      const rank=new Map(searchResultIds.map((id,index)=>[id,index]));
      ordered=[...all].sort((a,b)=>(rank.get(a.id)??Number.MAX_SAFE_INTEGER)-(rank.get(b.id)??Number.MAX_SAFE_INTEGER));
    }
    return {engine:"legacy-adapter",nodes:ordered.map(nodeFromMemory),edges:[],search:{query:search,resultIds:searchResultIds},disclosure:{inferredEdges:false,note:"Legacy Memory v3 has no persisted relation graph; no synthetic edges are fabricated."}};
  }
}

export class SuzuSelectiveMemoryAdapter extends MemoryEngine{
  constructor({legacy=new LegacyMemoryAdapter()}={}){super();this.legacy=legacy;}
  async retrieve(personaId,query,options={}){
    const rows=await this.legacy.retrieve(personaId,query,options);
    return rows.map(row=>({...row,representation_layer:"reported",temporal_state:row.memory.status==="retired"?"historical":(row.memory.temporal_state??"current"),evidence_mode:row.memory.source==="manual"?"manual":(row.memory.evidence_mode??"derived"),subject_role:"user",subject_key:personaId}));
  }
  graph(personaId,options={}){return this.legacy.graph(personaId,options);}
}

export const memoryEngine=new SuzuSelectiveMemoryAdapter();
