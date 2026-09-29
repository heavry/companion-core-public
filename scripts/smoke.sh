#!/usr/bin/env bash
set -euo pipefail
BASE="${BASE:-http://127.0.0.1:8765}"
KEY="${KEY:?请通过 KEY=... 提供 COMPANION_API_KEY}"
curl -fsS "$BASE/health"; echo
curl -fsS "$BASE/v1/models" -H "Authorization: Bearer $KEY"; echo
curl -fsS "$BASE/v1/chat/completions" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -H 'X-Companion-Source: smoke' -H 'X-Companion-Session: smoke-test' -d '{"model":"yuna-chat","stream":false,"messages":[{"role":"user","content":"只回复 Companion Core OK"}]}' ; echo
