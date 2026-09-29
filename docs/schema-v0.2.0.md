# Companion Core SQLite schema v2

`PRAGMA user_version = 2`。启动时在 `BEGIN IMMEDIATE` 事务内检查列并执行幂等迁移；只使用 `ALTER TABLE ... ADD COLUMN` 与 `CREATE INDEX IF NOT EXISTS`，不会重建或清空已有表。

## 从 v0.1.x 增加

- `sessions.archived_at TEXT NULL`
- `memories.last_accessed_at TEXT NULL`
- `memories.access_count INTEGER NOT NULL DEFAULT 0`
- `usage_log.kind TEXT NOT NULL DEFAULT 'chat'`
- `usage_log.cached_tokens INTEGER NULL`
- `idx_sessions_archived_updated`
- `idx_memories_filters`
- `idx_usage_created_source`

## 保持不变的数据

- `personas`
- `sessions` 现有行、summary 与 summary boundary
- `messages` 与原生 tool call 字段
- `memories`、`memory_fts`、`memory_embeddings`
- `events`
- `usage_log` 现有行
- `idempotency_cache`

旧 usage 行迁移后 `kind='chat'`，`cached_tokens=NULL`；新请求会按 `chat`、`agent`、`summary` 写入，并在上游提供时记录 cached tokens。
