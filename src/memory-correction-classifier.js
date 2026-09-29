const SWAP_RE=/不是\s*([^，,。！!?？]{1,32}?)\s*[，,。]?\s*(?:而是|是|我说的是)\s*([^，,。！!?？]{1,48})/u;
const AMBIGUOUS_OLD_RE=/不是\s*([^，,。！!?？\s]{2,16}?)(?:吧|呢|啊|了)?(?=[，,。！!?？]|$)/u;
const SELF_FIX_RE=/我(?:刚才|刚刚|之前)?(?:说错了|记错了|弄错了)\s*[，,。]?\s*(?:应该是|是|其实是)?\s*([^，,。！!?？]{2,40})/u;
const AMBIGUOUS_RE=/(?:好像|可能|也许|不太确定|不确定|记不太清|记不清|我也不确定)/u;
const PLAN_CHANGE_RE=/(?:之前|原来|本来).{0,20}?(?:想买|打算买|准备买|考虑买|想入手|打算入手)\s*([\p{L}\p{N}][\p{L}\p{N}_-]{1,23}).{0,20}?(?:现在|目前).{0,16}?(?:不(?:想|打算|准备)?(?:买|入手)).{0,24}?(?:准备|打算|改成|现在想)\s*(?:买|入手)?\s*([\p{L}\p{N}][\p{L}\p{N}_-]{1,23})/iu;

const clean=value=>String(value??"").replace(/^[\s：:「『“"'（(]+|[\s。！？!?」』”"'）)吧呢啊]+$/gu,"").trim();

export function classifyMemoryCorrection(text=""){
  const raw=String(text??"").trim();
  if(!raw)return null;
  const plan=raw.match(PLAN_CHANGE_RE);
  if(plan)return {kind:"plan_change",from:clean(plan[1]),to:clean(plan[2]),confidence:0.94};
  const swap=raw.match(SWAP_RE);
  if(AMBIGUOUS_RE.test(raw)&&(swap||/不是|不对/u.test(raw))){
    const old=swap?.[1]??raw.match(AMBIGUOUS_OLD_RE)?.[1]??null;
    return {kind:"ambiguous",from:old?clean(old):null,to:swap?clean(swap[2]):null,confidence:0.45};
  }
  if(swap){
    const from=clean(swap[1]),to=clean(swap[2]);
    if(from&&to&&from!==to)return {kind:"fact_correction",from,to,confidence:0.98};
  }
  const self=raw.match(SELF_FIX_RE);
  if(self){const to=clean(self[1]);if(to)return {kind:"fact_correction",from:null,to,confidence:0.97};}
  return null;
}
