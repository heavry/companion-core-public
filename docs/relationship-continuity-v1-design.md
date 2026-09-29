# Relationship Continuity + Absence Appraisal v1

## Absence Reaction Root Cause Map

```text
User silence
→ inactivity wake (6/12/20/30/40h)  ← ONLY elapsed time
→ gatherCandidateSet
     · inactivity is NOT a candidate
     · presence / expectation / open loop only
→ evaluateProactiveGate
     · unanswered_proactive → LONGER cooldown / no_reply_limit
     · i.e. harder to SEND, but no tone appraisal
→ composeMessage
     · “不要把经过时间当作主题”
     · silence-return-stance defaults light_return unless irritation residual
→ generic check-in
```

**Neutral reset causes**
1. `consecutiveUnansweredProactive` is gate-only (restraint), never emotion/appraisal input.
2. Next wake has no durable “I already reached out / they never replied” impression.
3. Compose prompt forbids elapsed-time themes → absence wording suppressed by design.
4. Stance `mild_edge` needs `irritation>=0.45` residual; absence does not raise irritation.
5. Closeness does not amplify absence salience.
6. `touchUserInteraction` zeros unanswered counter on any user return (gate OK) but there is no residual relationship impression either.

## Existing Relationship Signals
| Signal | Where | Durable | Used for |
|---|---|---|---|
| `lastProactiveAt` | companion-state | yes | cooldown |
| `consecutiveUnansweredProactive` | companion-state | yes | cooldown / no_reply_limit |
| `proactive_attempt_key` | message content_json | yes | idempotency |
| source=proactive | messages | yes | audit |
| Expectations + next_expected_actor | natural-cognition | yes | follow-up ownership |
| Open loops | natural-presence | yes | follow-up |
| Emotion residual | natural-presence | yes | tone |
| Contact suppression leave | contact-suppression.json | yes | WAIT |
| Closeness / irritation / social | presence dims | yes | stance / contactDecision |
| Recent Episodes | recent-episodes | yes | context / contradiction |

## Reused primitives
- Expectations (`next_expected_actor=user`) for **weak social expectation** on real questions
- Emotion causality structured causes for absence appraisal results
- Contact Suppression + new multi-day `known_busy` leave
- companion-state unanswered counter (keep)
- Event / episodes optional context only — **not** Memory injection

## Minimal v1
1. `relationship-continuity.js` — recent impressions (JSON sidecar, no schema bump)
2. `absence-appraisal.js` — structured absence → salience + mixed deltas + reason_code
3. Hook: outreach sent → impression (+ optional social expectation)
4. Hook: cognition wake → appraisal → stance + emotion cause + optional `absence_contact` candidate
5. Explained absence protection (busy/exam/don’t-contact multi-day)
6. Resolve/decay impressions on return + warm turns
7. Metrics + 12–15 targeted scenarios

**No schema bump.** Sidecar: `relationship-continuity.json` beside companion-state.
