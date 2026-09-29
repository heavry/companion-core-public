# Suzu Fusion source map

Research date: 2026-08-27

The research checkouts were shallow, sparse, and outside the Companion worktree. They are evidence sources, not runtime dependencies.

| Repository | Researched commit | Source paths read | Companion decision |
| --- | --- | --- | --- |
| `eryucheng/suzu-lives` | `a8f847dcf1e168e1f1ffc9bb0d6d625f8ea428fb` | `packages/agent-lifecycle/src/index.mjs` | Adapt the stable lifecycle vocabulary, deterministic hook ordering, bounded hook timeouts, immutable payloads, and monotonic `deny > ask > allow` decision rule. Companion implementation is original and smaller. |
| same | same | `packages/capability-runtime/src/index.mjs`, tests | Adapt the architectural rule that an executor must receive a verified control-plane decision, not trust model arguments. Companion retains Capability Registry, Action Intent, MCP policy, and module permissions as sources of truth. No Suzu signing-key/nonce subsystem is copied. |
| same | same | `packages/suzu-agent-runtime/src/embedded-agent-host.mjs`, `capability-bridge.mjs`, `context-token-estimate.mjs`, `compaction-defaults.mjs`, `companion-compaction.mjs`, `core-module-catalog.mjs` | Use as design reference for bounded steps, cancellation, tool pairing, token-aware compaction, and host/adaptor boundaries. Do not embed the Suzu host, Electron shell, provider catalog, or software-assistant bridge. |
| same | same | `packages/task-scheduler/src/index.mjs` | Design reference for once/cron parsing, serialized history, interrupted recovery, and duplicate prevention. Deferred after the current clean milestone; arbitrary script tasks will not be exposed by default. |
| same | same | `packages/cost-ledger/src/{catalog,calculator,store,index}.mjs`, price resources/schema | Design reference for append-only events, versioned prices, explicit unknown cost, and auditable calculations. Deferred after the current clean milestone. Existing `usage_log` remains append-only and preserves unknown token fields as SQL NULL. |
| same | same | `apps/control-center/src/react/{app-shell,today-page,plans-page,capabilities-page,memory-page,relationships-page,relationship-settings-page,settings-page}.jsx` and CSS | Information-architecture and interaction reference only. No React/CSS is copied. Companion remains native SwiftUI. |
| `eryucheng/suzu-memory` | `2a0aaedcaeed96a49942fc3d15a3a47e4720d712` | `packages/core/src/{ontology,policy,association-graph,access-dynamics,plasticity-policy}.mjs` | Adapt concepts behind an interface: representation layer, evidence disclosure, subject attribution, temporal state, and association graph. Do not adopt its database schema or migration owner. |
| same | same | `packages/retriever/src/{retriever,query,bm25-route,natural-decay,recall-reactivation,plasticity-ranking,affective-ranking}.mjs` | Design reference for multi-lane retrieval and auditable ranking. Current Legacy retrieval remains authoritative; richer lanes are future adapter work. |
| same | same | `packages/visualization/src/brain-layout.mjs`, service/SDK/server entrypoints | Adapt the safe graph API shape and explicit non-fabrication rule. Companion's first graph projection returns real legacy nodes and zero edges until relations are persisted. |

## Reuse classification

- Direct code copied: none.
- Adapted concepts with original Companion implementation: lifecycle contract, hard execution gate, bounded native loop, token measurement/compaction boundary, memory adapter vocabulary.
- Design-only references: Suzu scheduler, cost ledger, React information architecture, 3D brain layout, full structured-memory retriever.
- Explicitly rejected: Electron adoption, Suzu provider/model catalog, independent Agent host, arbitrary shell task execution, replacing `yuna-chat` or `yuna-agent`, backfilling or migrating the existing three memories.

## Runtime ownership

`yuna-chat` continues to use Companion's existing Chat provider route (Grok in the candidate configuration). When and only when Candidate Selector exposes registered Core/MCP tools, Companion's in-process Native Agent Runtime performs bounded model/tool steps. `yuna-agent` and its external DeepSeek/compat route are unchanged. No public model ID was added.

## Attribution

Both researched repositories are Apache-2.0. Suzu Lives' NOTICE identifies “Suzu Lives, Copyright 2026 儿玉诚也” and its canonical GitHub source. This milestone does not redistribute copied source, assets, React code, or vendor packages. Attribution is retained in `NOTICE.third-party.md` because the architecture was studied and concepts were adapted.
