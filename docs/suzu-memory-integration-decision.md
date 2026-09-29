# Suzu Memory integration decision

Decision: selective adaptation behind a Companion-owned `MemoryEngine` interface.

## Options evaluated

### Embed Suzu Memory packages

Rejected for v0.2.6.4. The packages own a substantially different SQLite schema, migrations, structured nodes/edges, evidence ledgers, retrieval services, and package dependency graph. Embedding them would create two migration owners inside one Core process and make rollback of the existing Memory v2 data risky.

### Run Suzu Memory as a sidecar

Rejected for the current release. A sidecar would add a second service lifecycle, authentication boundary, backup path, health state, and data reconciliation problem. It also makes the desktop App's “Core owns local data” guarantee less clear.

### Selectively adapt behind an interface

Chosen. `MemoryEngine` is the stable boundary. `LegacyMemoryAdapter` keeps the existing Memory v2 tables, FTS5/embedding retrieval, review workflow, and all current records readable. `SuzuSelectiveMemoryAdapter` adds explicit projection fields without altering legacy rows:

- `representation_layer=reported`
- `subject_role=user` and the current persona as `subject_key`
- `temporal_state=current|historical` from active/retired status
- `evidence_mode=explicit|derived` from the existing source

The `/admin/memory/brain` endpoint returns real legacy nodes. It intentionally returns no edges until Companion persists actual relations; the response discloses that synthetic edges were not fabricated.

## Safety and migration

- Memory v2 remains installed and authoritative.
- No existing row is rewritten or backfilled.
- No schema version is changed in this milestone.
- The current three active candidate memories remain readable through the adapter.
- Switching back is a code-level import reversal; the database needs no rollback.
- Full Suzu ontology, evidence tables, relation persistence, decay/reactivation, plasticity, affective ranking, and 3D layout remain future adapter phases, not implied by the initial projection.

## Retrieval ownership

Context injection now calls `memoryEngine.retrieve()`; the selected adapter delegates ranking and access accounting to the legacy retrieval implementation. Therefore this milestone changes the abstraction boundary, not the ranking behavior.
