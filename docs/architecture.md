# Architecture map for reviewers

The Node.js HTTP/WebSocket entry points are `src/server.js`, `src/router.js`, `src/runtime.js`, and `src/ws.js`. Configuration is read through `src/config.js`; durable SQLite schema and migrations are in `src/db.js`. `config/persona.json` is a source persona template, not a user record.

Conversation and context assembly span `src/responses.js`, `src/context.js`, `src/context-compaction.js`, `src/persona.js`, `src/character-runtime-v1.js`, `src/natural-messaging.js`, `src/natural-response-policy.js`, and `src/relationship-continuity.js`. Reasoning, turn coverage, social-act completion, and multi-bubble behavior are implemented across this flow and the message/stream modules.

Memory capture, selection, policy, retrieval, and corrections are in the `src/memory*.js` files, `src/event-association.js`, `src/recent-episodes/`, `src/recent-utterances/`, and `src/natural-diary/`. Presence and autonomous state are in `src/natural-presence/`, `src/companion-state.js`, `src/absence-appraisal.js`, `src/autonomous-life/`, and related stores.

Proactive decisions and delivery involve `src/scheduler.js`, `src/proactive.js`, `src/inactivity-proactive.js`, `src/proactive-ownership.js`, `src/proactive-delivery-policy.js`, and `src/contact-suppression.js`. The 6h/12h/20h/30h/40h inactivity buckets and unanswered-contact state can be followed in those files and `scripts/proactive-unanswered-timeline-test.js`.

Agent, tool, and resume paths include `src/agent-lifecycle.js`, `src/agent-task-store.js`, `src/native-agent-runtime.js`, `src/local-agent-runtime.js`, `src/agent-tools-v1.js`, `src/tool-registry.js`, `src/session-permissions.js`, `src/computer-use-*`, `src/mcp/`, and `src/modules/`.

Voice and modality span `src/voice-*`, `src/tts-providers.js`, `src/local-gpt-sovits-service.js`, `src/local-sensevoice-service.js`, and `src/assistant-voice-bubble.js`. The macOS client lives in `CompanionMac/Sources/`, with its tests in `CompanionMac/Tests/`. Voice weights, audio references, recordings, and the portrait are intentionally absent.

The `scripts/` directory contains retained offline checks. Live acceptance scripts and raw diagnostics were excluded. Review the code against the tests, but treat this source-only mirror as an audit artifact rather than proof of deployment behavior.
