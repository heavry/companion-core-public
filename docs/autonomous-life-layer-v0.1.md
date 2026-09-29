# Autonomous Life Layer v0.1

## Existing architecture and reusable boundaries

The repository is a single Node.js Core with a Swift macOS client. The Core already owns the OpenAI-compatible Chat/Responses APIs, provider failover and per-kind routing, Persona injection, SQLite sessions/messages/events/memories, summary and memory extraction workers, FTS/embedding retrieval, scheduler, proactive delivery, TTS/STT/wake word, MCP/modules, Native Agent tools, permission gates, usage ledger and realtime events.

The v0.1 layer deliberately reuses those boundaries:

| Existing subsystem | Reuse in v0.1 |
| --- | --- |
| `src/context.js` | Adds a compact read-only autonomous-state block to both Chat and Responses provider inputs. |
| `src/proactive.js` | Keeps quiet hours, cooldown, daily caps, no-reply suppression, candidate gathering, message composition and delivery. |
| `src/scheduler.js` | Remains the precise once/cron planner. Autonomous goals do not duplicate cron scheduling. |
| `src/db.js` messages | Working memory remains recent session messages plus session summary. |
| `events` | Existing episodic event layer remains available to normal context retrieval. |
| `memories` and `memory-engine.js` | Existing semantic/relationship memory remains authoritative for user facts and preferences. Autonomous preferences are stored separately so agent tendencies do not pollute user memory. |
| capability registry and permission gate | Tool safety and scoped execution remain unchanged after an accepted request. |
| provider routing, TTS and APIs | No replacement or fork; accepted requests use the original paths. |

## New directory

```text
src/autonomous-life/
  decision.js       deterministic request signals and ACCEPT/REFUSE/DELAY/NEGOTIATE
  reflection.js     event aggregation and gradual preference updates
  state-store.js    atomic persistence, time evolution, goals and heartbeat
  index.js          configured singleton and event-bus bridge
```

The durable file defaults to `<database directory>/autonomous-life.json` with mode `0600`. It is independent from `companion-state.json`: the latter remains delivery/behavior policy, while the new file owns internal state, goals, reflection and learned behavioral tendencies.

## Request data flow

```text
authenticated and schema-valid request
  -> persist the new user message
  -> record a bounded interaction event and evolve time-derived state
  -> hard safety signal
  -> active goals
  -> internal state
  -> reflected long-term behavioral preferences
  -> ACCEPT / REFUSE / DELAY / NEGOTIATE
  -> ACCEPT: original Persona/Memory/Tool/Provider/TTS path
  -> other: local OpenAI-compatible response, zero provider calls
```

The local refusal set is intentionally narrow. Ordinary requests remain accepted. There is no random anger or probability-based refusal. An urgent incident marker bypasses fatigue/goal-delay rules but never bypasses the hard safety boundary or existing tool permission checks.

## Persistent internal state

The initial state is conservative and bounded to `[0,1]`. Each interaction makes small evidence-based changes. Every clock advance divides elapsed time into active and idle portions using a configurable recent-activity window.

- `activeTimeSeconds`, `idleTimeSeconds`, `lastInteractionAt`, `activeSince`: clock-derived.
- `energy`, `fatigue`: active use consumes/reinforces; idle time recovers/decays.
- `mood`, `irritability`, `curiosity`, `socialDrive`, `recentAnnoyance`: continuous values that move toward baselines over time.
- `trust`: changes slowly from interaction evidence and very slowly returns toward baseline.

Only event tags, time, effort and session id are kept in the autonomous event buffer; raw user text is not duplicated into this file.

## Goals

Goals have a stable id, title, status, priority, rationale, next step, optional next-step time, `autoContinue`, source session and timestamps. Status is `active | paused | completed | cancelled`. A due `autoContinue` step produces `CONTINUE_GOAL`; v0.1 does not automatically execute arbitrary tools or background code from a goal.

## Heartbeat

The existing timer calls one local decision pass:

1. Evolve time-derived state and expire old proactive follow-ups.
2. Prefer `REST` when recovery is needed.
3. Run rules-only `REFLECT` when enough new evidence accumulated.
4. Select a due `CONTINUE_GOAL`.
5. Select `START_CONVERSATION` only when an existing proactive candidate exists.
6. Select `USE_TOOL` for the existing low-frequency weather watchdog.
7. Otherwise choose `OBSERVE` or `WAIT`.

`REFLECT`, `WAIT`, `OBSERVE`, `REST`, and goal selection use no LLM. `USE_TOOL` reuses the existing local module trigger. Only `START_CONVERSATION` may call the main provider, and all existing proactive delivery gates still apply.

## Reflection and memory layers

Reflection aggregates tagged interactions since the prior reflection. Repeated goal switching, boundary pressure, appreciation and curiosity can gradually adjust persistent behavioral tendencies with confidence and evidence counts. A single event cannot create a strong long-term preference.
Preference strength decays gradually toward neutral over time when later reflections are consolidated, while confidence decays on a slower half-life. Heartbeat candidates only reach `START_CONVERSATION` when social drive is high enough and annoyance/irritability are below their local gates.

The three memory roles in the current repository remain:

- Working Memory: recent session messages and summary.
- Episodic Memory: timestamped events and autonomous reflection records.
- Semantic / Relationship Memory: filtered long-term SQLite memories.

V0.1 keeps autonomous preferences inside the new layer. A future consolidation policy may promote a reflection into shared memory only with explicit subject/provenance semantics; it must not write the agent's own preference as if it were a fact about the user.

## Configuration

```env
COMPANION_AUTONOMOUS_LIFE_ENABLED=true
COMPANION_AUTONOMOUS_LIFE_STATE_PATH=./data/autonomous-life.json
COMPANION_AUTONOMOUS_ACTIVE_WINDOW_SECONDS=1800
COMPANION_AUTONOMOUS_REFLECTION_EVENT_THRESHOLD=8
COMPANION_AUTONOMOUS_REFLECTION_MIN_INTERVAL_SECONDS=21600
```

The first flag is the whole-layer kill switch. When false, the store performs no reads/writes, context injection is empty, heartbeat returns `WAIT`, and request decisions return `ACCEPT` so the original path is preserved.

`GET /admin/autonomous-life` exposes current state and goals, bounded recent decision and heartbeat histories, recent reflections, and the last proactive trigger result including whether the main LLM was actually called. Raw user text is not copied into these diagnostic histories.

## Future embodiment boundary

Robot hardware is intentionally absent. Future embodiment should register actions such as `MOVE_TO_USER`, `LOOK_AT_USER`, `FOLLOW_USER`, and `TOUCH_OBJECT` through the existing capability/tool registry and permission system. Persona, memory, state, goals and reflections remain body-independent.
