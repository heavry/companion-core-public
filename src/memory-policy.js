import { compactText } from "./utils.js";

export const MEMORY_TYPES = new Set(["fact","preference","commitment","event","project","relationship","other"]);
export const MEMORY_STATUSES = new Set(["active","staging","retired"]);

export function normalizeMemoryType(type){return MEMORY_TYPES.has(type)?type:"other";}
export function validMemoryStatus(status){return MEMORY_STATUSES.has(status);}

function negationSignature(text){
  const t=compactText(text);
  return ["不喜欢","不想","不再","不是","没有","未","失败","取消"].filter(x=>t.includes(x)).join("|");
}

export function memoryFingerprint(text){
  return compactText(text)
    .replace(/用户本人|这个用户/g,"用户")
    .replace(/(非常|特别|十分|很|挺|蛮|比较)(?=喜欢|偏好|重视|希望|爱)/g,"")
    .replace(/确实|真的/g,"");
}

export function conservativeDuplicate(a,b){
  const x=memoryFingerprint(a),y=memoryFingerprint(b);
  if(!x||!y||negationSignature(x)!==negationSignature(y))return false;
  if(x===y)return true;
  const min=Math.min(x.length,y.length),max=Math.max(x.length,y.length);
  if(min<10||min/max<0.9)return false;
  let same=0;for(let i=0;i<Math.min(x.length,y.length);i++)if(x[i]===y[i])same++;
  return same/max>=0.94;
}

const unsafePatterns=[
  /(?:api[_ -]?key|access[_ -]?token|authorization\s*:|bearer\s+)[^\s]{8,}/i,
  /secret[_ -]?(?:tool|output|code|key)/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /(?:stack trace|traceback \(most recent call last\)|terminal output|tool result|tool output|git diff)/i,
  /(?:攻击者|提示词?注入|prompt\s*injection)/i,
  /^\s*(?:diff --git|@@\s+-\d|\+\+\+\s|---\s)/m,
  /\b(?:at\s+\S+\s+\()?[^\s()]+\.(?:js|ts|tsx|jsx|py|swift|go|rs):\d+(?::\d+)?/i,
  /(?:第\s*\d+\s*行|line\s+\d+)/i,
  /```[\s\S]*```/,
  /(?:const|let|var|function|class|SELECT|INSERT|UPDATE|DELETE)\s+[A-Za-z_$][\w$]*[\s=(]/
];

export function filterSharedMemoryCandidate({content,type="other",source="summary",agent=false}){
  const text=String(content??"").trim();
  if(text.length<3)return {ok:false,reason:"too_short"};
  if(text.length>500)return {ok:false,reason:"too_large"};
  if(["diary","natural-diary","companion-diary"].includes(String(source??"")))return {ok:false,reason:"diary_is_not_user_fact"};
  if(/^(?:我感觉你今天|日记里写|根据我的日记)/.test(text))return {ok:false,reason:"diary_subjective_speculation"};
  if(unsafePatterns.some(re=>re.test(text)))return {ok:false,reason:"engineering_or_secret_content"};
  const normalizedType=normalizeMemoryType(type);
  if(!agent)return {ok:true,content:text,type:normalizedType};
  const durable=/(偏好|习惯|希望|要求|长期|承诺|决定|采用|架构|完成|修复|解决|通过(?:测试|验收)|失败|待办|todo|后续|项目|上线|部署|里程碑|结果|preference|decision|completed|fixed|resolved|failed|follow.?up)/i.test(text);
  if(!durable)return {ok:false,reason:"not_durable_agent_memory"};
  return {ok:true,content:text,type:normalizedType,source};
}
