import { config } from "./config.js";
import { invocationLedger } from "./usage-ledger.js";
const state={enabled:config.embeddingEnabled,available:config.embeddingEnabled?null:false,model:config.ollamaEmbedModel,last_checked_at:null,error:config.embeddingEnabled?null:"disabled"};
let lastAttempt=0;

export async function embedText(text){
  if(!config.embeddingEnabled) return null;
  if(state.available===false&&Date.now()-lastAttempt<config.embeddingProbeIntervalMs)return null;
  lastAttempt=Date.now();state.last_checked_at=new Date().toISOString();
  try{
    const r=await fetch(`${config.ollamaBaseUrl}/api/embed`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({model:config.ollamaEmbedModel,input:text}),signal:AbortSignal.timeout(config.embeddingTimeoutMs)});
    if(!r.ok)throw new Error(`Ollama embed failed: ${r.status}`);
    const j=await r.json(),vector=j.embeddings?.[0]??null;
    if(!Array.isArray(vector)||!vector.length)throw new Error("Ollama embed returned no vector");
    state.available=true;state.error=null;return vector;
  }catch(e){state.available=false;state.error=e?.name==="TimeoutError"?"timeout":String(e?.message??e).slice(0,160);throw e;}
  finally{invocationLedger.append({provider:"ollama",model:config.ollamaEmbedModel,publicModel:"embedding",feature:"embedding",source:"memory",usageSource:"provider_not_reported",inputTokens:null,cachedInputTokens:null,reasoningTokens:null,outputTokens:null});}
}
export function getEmbeddingStatus(){return {...state,base_url:config.ollamaBaseUrl};}
export function cosine(a,b){ if(!a?.length||a.length!==b?.length)return 0; let d=0,aa=0,bb=0; for(let i=0;i<a.length;i++){d+=a[i]*b[i];aa+=a[i]*a[i];bb+=b[i]*b[i];} return aa&&bb?d/(Math.sqrt(aa)*Math.sqrt(bb)):0; }
