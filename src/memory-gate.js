// Memory Gate：Stage A 轻量启发式判断，命中才允许进入 Stage B extraction LLM。
// 目标：绝大多数普通闲聊 0 额外 LLM 调用、0 memory 写入。
import { compactText } from "./utils.js";
import { classifyMemoryCorrection } from "./memory-correction-classifier.js";

const SYMBOLS_ONLY = /^[\s\d\p{P}\p{S}]+$/u;

const EXPLICIT_REMEMBER = /(记住|记下|别忘了|不要忘记|帮我记|先记住|给我记住|remember(?:\s+that)?|don'?t\s+forget|keep\s+in\s+mind)/i;
const EXTERNAL_FRAMING = /(?:网页|网站|搜索结果|工具(?:调用|输出|结果)|终端输出|notion|playwright|tavily|weather|web\s*search).{0,20}(?:写|说|显示|返回|要求|提到|包含)/i;
const CORRECTION = /(?:我.{0,16}(?:现在更喜欢|不再喜欢|改成了|换成(?:了|成)|之前说错|不是.{0,8}而是)|\bi\b.{0,24}(?:no\s+longer|changed?\s+my\s+.+\s+to))/i;
const PREFERENCE = /(?:我.{0,32}(?:喜欢|偏好|最爱|最喜欢|不太喜欢|不喜欢|讨厌|习惯了|习惯于)|\b(?:i|my)\b.{0,32}(?:prefer\w*|favorite|like|dislike))/i;
const STABLE_FACT = /(我叫|我的名字是|我的名字叫|生日是?(我)?|我在读|我住在|我在(上|念)|我的默认|我用的是|my name is|i (live|study) in)/i;
const GOAL_PROJECT = /(长期(目标|项目|计划)|目标是|我打算长期|正在长期做|想坚持|在做的项目|(long.?term|main) (goal|project))/i;
const HABIT_SETTING = /(默认(保持|开启|关闭|用)|(每次|以后)都?(要|用|开)|(一直|总是)(用|开|保持)|(keep|start|leave)\s+it\s+(on|off)\s+by\s+default)/i;

/**
 * 返回 {hit:boolean, reason:string}。纯同步正则，无任何 IO/LLM。
 * 只分析用户本人的原文；web/tool 内容不会进入该函数（调用点仅传 role=user 文本）。
 */
export function memoryGate(text){
  const t = String(text ?? "").trim();
  if(t.length < 4 || compactText(t).length < 4) return {hit:false, reason:"too_short"};
  if(SYMBOLS_ONLY.test(t)) return {hit:false, reason:"digits_or_symbols_only"};
  // 明确“记住”意图优先级最高：即使句式是疑问/请求也进入候选
  if(EXPLICIT_REMEMBER.test(t)) return {hit:true, reason:"explicit_remember_intent"};
  // 第三方网页 / 工具内容即使含“偏好”等词，也不能被当成用户本人陈述。
  if(EXTERNAL_FRAMING.test(t)) return {hit:false, reason:"external_content"};
  if(classifyMemoryCorrection(t)) return {hit:true,reason:"correction_update"};
  // 纯提问（没有陈述新事实）不记录，避免“你喜欢什么颜色？”这类误触发
  if(/[?？]\s*$/.test(t)) return {hit:false, reason:"question_no_statement"};
  if(CORRECTION.test(t)) return {hit:true, reason:"correction_update"};
  if(PREFERENCE.test(t) || STABLE_FACT.test(t) || GOAL_PROJECT.test(t) || HABIT_SETTING.test(t)) return {hit:true, reason:"stable_personal_signal"};
  return {hit:false, reason:"no_memory_signal"};
}
