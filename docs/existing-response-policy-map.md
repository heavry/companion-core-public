# Existing Response Policy Map

Date: 2026-09-25  
Sources: `src/natural-response-policy.js`, `src/natural-messaging.js`, `src/emotion-causality.js`, `src/natural-presence/store.js`, `src/post-message-cognition.js`, `src/context.js`, `config/persona.json`, `src/server.js` chat path.

## 1. Act inventory (v1)

```
ACK, REACT, QUESTION, TEASE, COMMENT, CALLBACK, SHIFT, ADVICE, CLOSURE, SILENT_CONTEXT
```

Selection order (deterministic, first match wins):

1. closure strong/medium → CLOSURE  
2. safety necessity → ADVICE  
3. explicit advice request → ADVICE  
4. SHIFT_AMBIGUOUS → QUESTION  
5. explicit recall / callback → CALLBACK  
6. minimal ack → ACK  
7. playful + playfulness≥0.55 → TEASE  
8. complaint → REACT  
9. return/event report → REACT  
10. clear topic shift → SHIFT  
11. user question → COMMENT (answer)  
12. default COMMENT  

Secondary (only if primary not ACK/ADVICE/CLOSURE/QUESTION): rare extras (REACT after CALLBACK complaint, COMMENT after TEASE question, QUESTION after ambiguous shift).

## 2. How a turn is framed in generation

Stack order in daily `natural_chat`:

1. `NATURAL_MESSAGING_SYSTEM`
2. persona system (`personaSystem`)
3. memories / events / session summary
4. rest of conversation history (incl. recent assistant turns as messages)
5. autonomy/presence/cognition/diary/episode/recurrence/grounding/repair/time
6. **Natural Response Policy block + Emotion Expression + Closure guidance**
7. model → JSON bubbles
8. `inspectNaturalResponseCandidate` (optional one rewrite)
9. `finalizeBubblePlan` (semantic regroup, dangling opener)
10. `deliverBubbleSequence` (DB + SSE + async voice)
11. `maybeRunPostMessageAfterPrimary` (optional Bubble2)

## 3. Policy block content (what the model is told)

From `naturalResponsePolicyBlock`:

- `Context ≠ Required Mention`
- `primary_act=…; optional_secondary_act=…; context_disposition=…`
- `advice_allowed / closure_allowed / situation_summary_allowed`
- 通常只完成 primary；禁止拼成 ACK+复述+ADVICE+CLOSURE
- silent-use context
- advice only if allowed
- closure only if allowed
- no situation summary unless asked

**Gap:** still act-completion oriented. No impulse language. No “stop when done”. No selective attention. No stance. No “familiarity reduces formality”.

## 4. Natural Messaging constraints

- JSON `messages[]`, 1–3 bubbles
- one element = one complete chat action
- short reply 1 bubble; casual 1–2; two thoughts 2–3
- allow short forms; forbid constant summary/care+question/advice/closure
- no dangling openers

**Gap:** “完整聊天动作” + bubble-count defaults invite a full little answer. No “one impulse is enough / can stop mid-stream”.

## 5. Emotion → realization mapping

| Emotion | Current style guidance | Completeness risk |
|---|---|---|
| happy | warmer, more willing to continue | multi-bubble + soft |
| excited | light, may be short | ok |
| annoyed | less explain/soothe, may 顶 | ok |
| angry | hard/short, may blunt | ok |
| hurt | withdraw, less jokes, cool | can still soothe later |
| low | shorter, no comfort template | ok |

Missing: everyday high closeness should **not** default to soothing; hurt can still **顶** / be cool without being washed flat.

## 6. High closeness

- Presence label `clingy` when closeness≥0.8 and social≥0.8
- hint: more willing to continue, slightly clingy, tease; multi-bubble more natural
- voice style `warm_close_social` when closeness≥0.85

**Mapping today:** intimacy → more social packaging.  
**Needed:** intimacy → less social formality (directer, more tease/challenge/complain, fewer polite closers).

## 7. Reassurance / Advice / Closure

| Channel | v1 behavior | Remaining issue |
|---|---|---|
| ADVICE | only explicit request or safety | good; still rare over-trigger via ADVICE_OUTPUT rewrite |
| CLOSURE | only medium/strong release | good for leave; soft_ack is ACK; still “尾巴” culture in repair/echo |
| REASSURE | **not a first-class act** | model invents reassurance inside COMMENT/REACT |
| summary | only if requested | good |

`REASSURE` must become an ordinary impulse, not an automatic side effect of emotion/intimacy.

## 8. Post-message Bubble2

Gate (`evaluatePostMessageGate`):

- blocked: user leaving / silence / closureLikely / contact suppressed / recent followups≥2
- candidates: association / active memory / open loop / expectation (salience thresholds)
- emotion only lifts slightly; never alone

Prompt (`buildFollowupPrompt`):

- “确有新信息时**补一句**”
- afterthought_reason / afterthought_topic
- 1–2 sentences, don’t restate

**Gap:** “补一句” + emotional/important addendum reasons encourage completeness padding.  
Need: Bubble2 requires a **new conversational impulse**; else `NO_FOLLOWUP`.

## 9. Recent assistant expression

- Full prior assistant text in history (natural).
- `responseActHistory` last 8 realized acts in-process for structure rhythm-break (only two consecutive COMMENT structures).
- `recentStructure` regex tags SUMMARY/ADVICE/CLOSURE/QUESTION.

**Gap:** no light posture awareness (3× soothing closure, 3× same tease). Not a blacklist — just “don’t pick the same posture again”.

## 10. Casual vs task

- Daily chat path is Natural Messaging unless tools divert.
- Policy has no explicit “task request must stay complete” exception beyond ADVICE_REQUEST / SUMMARY_REQUEST / USER_QUESTION→COMMENT.
- Selective attention is not declared legal for casual chat, and **must not** break multi-question task turns.

## 11. Candidate gate / repair (existing guards)

`inspectNaturalResponseCandidate` + `enforceNaturalResponseCandidate`:

- malformed JSON
- verbatim recent reply
- third same response structure
- unselected question
- minimal ACK overanswered
- closure/advice act not realized

This is already a guard layer. **Do not add more named guards.** Prefer first-generation framing.

## 12. Answers to the AUDIT questions

1. **Why complete answers?** Coverage act selection + “完整聊天动作” + dense context + persona accuracy + no stop rule.  
2. **Implicit acknowledge+react+reassure+explain+closure?** Yes, as a social script baked into COMMENT/REACT defaults and repair language; not as explicit checklist, but as the shape of “good reply”.  
3. **How are acts chosen?** Regex/priority table above (v1).  
4. **One act per turn allowed?** Yes in policy text (“通常只完成 primary”), but secondary + bubble defaults + post-message undo it.  
5. **Why expand after reaction?** No stop criterion; “complete chat action”; post-message “补一句”; repair rewrites.  
6. **High closeness → supportive?** Partially yes (warm/clingy/multi-bubble). Not fully counselling, but warmth default.  
7. **Does supportive suppress tease/disagreement?** Persona 温和 + happy-warm + hurt-withdraw + no DISAGREE/CHALLENGE acts → yes, in practice.  
8. **Don’t miss user info?** Implicit via USER_QUESTION→answer and COMPLAINT+event coverage; no selective attention license.  
9. **Recent assistant turns in prompt?** As chat history + light structure rhythm; not expression posture.  
10. **Bubble2 completeness?** Yes, “补一句” + afterthought reasons.  
11. **Length/completeness guidance?** Messaging bubble counts + “完整聊天动作” + medium verbosity.  
12. **Response-quality instruction covering every point?** Indirectly: answer_current_question + silent-use still lists many backends; no “may ignore minor points”.  
13. **“一句话就够了” allowed?** Weakly (ACK short), not as general casual rule.  
14. **Ignore secondary parts?** Not allowed explicitly.  
15. **Persona stance vs adjectives?** Mostly adjectives/tone; little stance.

## 13. Keep working (do not redesign)

Natural Presence, Emotional Causality, Expectation+Focus, Memory Gating+Correction, Event Association, Memory Accessibility, Proactive Cognition, Contact Suppression, Open Loops, Recent Episodes, Bubble Finalization, Turn Recovery, Network Resilience, Post-message cognition, Voice Async, Relationship Continuity, Absence Appraisal.

They remain **context**, not required response acts.
