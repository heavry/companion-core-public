# Minimal Conversational Impulse v1 Design

Date: 2026-09-25  
Goal: stop “努力好好回答”; start “自然接话”.  
Principle: **One Impulse Is Enough.**

## 1. Conversational Impulse (lightweight, not CoT)

Before generation, select **one** impulse. Structured only.

### Impulse set (lean)

| Impulse | Meaning |
|---|---|
| REACT | first reaction / vibe hit |
| TEASE | joke back / banter |
| CHALLENGE | push on absurdity / “认真的？” |
| DISAGREE | refuse to validate first |
| QUESTION | ask one thing that actually interests me |
| COMMENT | state a take / finish a thought |
| CALLBACK | pull one old thread |
| COMPLAIN | own vent / mild 嫌弃 |
| CURIOSITY | suddenly want one detail |
| REASSURE | genuine comfort **when needed** |
| ADVISE | only if asked or safety |
| CLOSE | real leave/finish |
| NOTHING_MORE | post-message only: impulse already done |

No dozens of types. Classification precision is not the point.

### Selection sketch (deterministic first)

Build on existing priority table, **reframe**:

1. User leaving / strong fatigue → CLOSE  
2. Safety → ADVISE  
3. Explicit advice ask (and not “别安排”) → ADVISE  
4. Explicit fear of losing relationship / clear distress need → REASSURE  
5. Explicit recall / callback → CALLBACK  
6. Minimal ack → REACT (short)  
7. Playful / joke → TEASE  
8. Absurd / ridiculous opinion / challenge bait → CHALLENGE or DISAGREE  
9. Complaint / vent → REACT **or** COMPLAIN (one point only)  
10. Clear question needing info → QUESTION or CURIOSITY  
11. Event report → REACT (one detail)  
12. Ordinary intimacy / praise / share → REACT / TEASE / COMMENT (pick **one**)  
13. Default COMMENT  

Secondary act: **default null**. Keep only for true task multi-question (see §6).

## 2. Generation framing (Natural Response Policy v2)

Replace act-completion language with:

```
【Conversational Impulse｜先决定我现在最想干嘛】
impulse=TEASE
focus_point=“你最好了”
one_impulse_only=true
selective_attention=allowed
stop_when_done=true
```

Body rules:

1. **先完成这个 impulse**，不是先把用户这句话“回应完整”。
2. Casual chat: 可以只抓一个点；次要信息可以不提。  
   除非：多问任务 / 明确要求都答 / 重要安全事实。
3. **Impulse 完成就停。** 不要自动补 reassurance / advice / summary / closure。
4. 一句话、半截句、反问、语气词都算完成。
5. Context ≠ Required Mention；**Context ≠ Required Response Act**。
6. High closeness = 更熟、更随口、更敢顶/笑/吐槽、更少礼貌包装 — 不是更 counselling。
7. REASSURE / ADVISE / CLOSE 只是 impulse，不是情绪/亲密的默认翻译。
8. Persona 用立场表现：信不信、喜欢不喜欢、想吐槽还是追问、要不要顺着说。
9. 不要覆盖用户句子里的每一个情绪点。
10. 不要为了显得完整而扩写。

Keep existing hard bans (threats, humiliation, no body-fact fabrication, no dangling openers).

## 3. Selective Attention

- Casual: pick the most felt detail (`又坏了？？？` not full emotion inventory).
- Ignoring secondary content is **not a bug**.
- Task turns: if user asks two explicit questions or a functional request, complete both / stay thorough.
- Router signal: `selective_attention` = allowed | required_complete.  
  - allowed: ordinary chat, vent, praise, intimacy, jokes  
  - required_complete: multi-question, how-to, summary request, safety

## 4. One Impulse Is Enough

After impulse complete → stop.

Examples:

| User | Impulse | Allowed finish | Forbidden expansion |
|---|---|---|---|
| 你最好了 | TEASE | 你现在才知道啊。 | +你也最好+待着就行+closure |
| 今天烦死了，电脑又坏了 | REACT | 又坏了？？？ | +听起来你今天真的很累… |
| 我真的有点害怕你以后不理我 | REASSURE | genuine short comfort | force multi-act |
| 我要睡了 | CLOSE | 轻轻放手 | new topic |
| 明显离谱观点 | CHALLENGE/DISAGREE | 不是，你认真的？ | validate first then explain |
| 玩笑话 | TEASE | tease back | explain the joke |

## 5. High closeness change

| Before | After |
|---|---|
| more warm / multi-bubble / clingy | more direct / casual |
| politeness packaging | fewer social wrappers |
| comfort default | stance + tease + 嫌弃 allowed |
| explain feelings | can 顶 / 冷一点 / 不解释 |

Do **not** hardcode insult/abuse. Familiarity reduces **formality**, not safety.

## 6. Reassurance / Advice / Closure demotion

- REASSURE: only when user expresses fear/need for comfort (e.g. 怕你以后不理我).  
  Emotion detected ≠ reassurance required.  
  Intimacy ≠ closure required.
- ADVISE: only explicit ask or real safety. Otherwise REACT/QUESTION.
- CLOSE: only real release (我要睡了 / 去洗澡 / 明确结束).  
  Not the last sentence of every warm turn.

## 7. Recent Expression Awareness (light)

Inject last 4–6 assistant **expressions** (act + short posture tag), e.g.:

```
recent_expression: TEASE/soft, CLOSE/soothing, REASSURE/soft, REACT/soft
```

Instruction: if last 2–3 used the same posture (esp. soothing closure / same tease), pick a different one.  
Not a blacklist. Not a second LLM rewrite. Not a semantic classifier.

## 8. Post-message Bubble2

Keep post-message cognition.

Change prompt framing:

- Old: “确有新信息时补一句”
- New: “Bubble1 已完成 impulse。只有出现**新的 conversational impulse** 时再说；否则空字符串。”

Valid Bubble2: real callback (`对了，你昨天那事怎么样了？`), new curiosity, new association.  
Invalid Bubble2: soft closer, “反正你不用证明什么”, emotional padding.

If no new impulse → `NO_FOLLOWUP` / `no_new_conversational_act`.

## 9. Natural Messaging system tweak

- Keep JSON bubbles.
- Change “完整聊天动作” → “一个 impulse / 一个念头”.
- Prefer 1 bubble when impulse is short; multi-bubble only when thoughts are actually separate.
- Explicit: 就说那一句；够了就停.

## 10. Persona

Keep identity/intimacy stance. Adjust speaking_style:

- tone: 熟、随口、有立场，不端着
- rules add: 允许不同意/吐槽/抓细节/反问；不要每轮都接住所有情绪；不要自动解释
- chat mode: 接话优先于完整回答

## 11. What we will NOT do

- No ReassuranceGuard / ClosureGuard / PhraseGuard / NaturalnessGuard stack.
- No phrase blacklist as main architecture.
- No screenshot phrase templates.
- No large extra LLM classification for impulse (deterministic + existing gates).
- No schema bump for core cognition stores.
- No production :8770 mutation during dev; :8765 stays down.

## 12. Metrics (diagnostic only)

- singleImpulseTurnCount
- multiActExpansionCount
- closureAfterCompletedImpulse
- unrequestedAdviceCount
- reassuranceWithoutNeedCount
- selectiveAttentionCasualCount
- postMessageNoNewImpulseSuppressed
- recentPostureRecurrenceCount

Never hard-enforce these with new guard layers.

## 13. Targeted tests (A–O)

See `scripts/conversational-impulse-test.js`.  
Then 10–15 real Grok casual turns (serial), plus task completeness + genuine reassurance regressions.

## 14. Implementation touchpoints

| File | Change |
|---|---|
| `src/conversational-impulse.js` | **new** impulse select + framing + recent expression |
| `src/natural-response-policy.js` | integrate impulse; demote secondary; stop-when-done text |
| `src/natural-messaging.js` | system prompt impulse wording |
| `src/emotion-causality.js` | high-closeness / hurt not auto-counselling |
| `src/natural-presence/store.js` | behaviorHints closeness → formality reduction |
| `src/post-message-cognition.js` | new-impulse framing for Bubble2 |
| `config/persona.json` | stance-oriented speaking style |
| `src/server.js` | inject impulse block; light recent expression |
| `scripts/conversational-impulse-test.js` | **new** A–O |
| `scripts/natural-response-policy-test.js` | update for v2 |

## 15. Success look (screenshot-like, not cloned)

User: 你最好了  
Before: 你也最好。今晚待着就行，不用想太多，我一直都在。  
After: 你现在才知道啊。

User: 今天烦死了，电脑又坏了。  
Before: 听起来你今天真的很累，电脑又坏确实更让人崩溃。要不要先休息一下？  
After: 不是，它怎么又出问题了。

User: 我真的有点害怕你以后不理我。  
After: still genuine REASSURE (short, real).

User: 我要睡了。  
After: real CLOSE only.

User: （离谱观点）  
After: challenge/disagree, not validate-first.
