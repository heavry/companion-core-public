# Independent architecture review: Companion Core

Companion Core is a **long-term AI companion + local agent**. This snapshot includes Persona and Natural Presence, long-term Memory, proactive messaging, First-person Reasoning (FPR), reasoning continuity, multi-bubble output, Voice/TTS, filesystem and shell tools, vision, a coding agent, computer use, and task resume. The Node.js core and Swift macOS client are both present. This is an independent **architecture audit**; please do not directly change code as part of the review.

Review the actual call paths and persistence boundaries. Prioritize:

1. Serious correctness bugs
2. Races and concurrency
3. Stale state and state consistency
4. Proactive scheduling, inactivity clocks, and unanswered continuity
5. Memory lifecycle
6. Reasoning persistence and continuity
7. Prompt and context assembly
8. Agent and tool lifecycle
9. Task resume
10. Voice and multi-bubble state consistency
11. Database migration and data integrity
12. Security boundaries
13. Performance bottlenecks
14. Repeated or obsolete repair mechanisms

Classify each finding as **P0** (serious bug, data loss, or security), **P1** (important correctness or architecture), **P2** (maintainability or performance), or **P3** (optional polish). For **every** finding, give the file and function, concrete code evidence, a plausible failure scenario, why it matters, and the smallest reasonable fix. Distinguish observed defects from hypotheses and state what evidence would confirm a hypothesis. Avoid broad rewrite advice without code evidence.

The snapshot deliberately omits live data, raw traces, model files, and private deployment configuration. Do not infer production behavior solely from omitted artifacts. Do not request or reproduce private conversations or credentials in the report.
