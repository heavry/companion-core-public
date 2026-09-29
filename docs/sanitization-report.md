# Sanitization notes for this audit snapshot

Source: candidate commit `3f4991a`, exported from its tracked file tree into a new directory. No original `.git` directory or commit history was copied. The mirror changes below are confined to this audit copy; they are not a runtime rollout.

Included: Node.js Core sources, Swift macOS client sources and tests, admin UI, module samples, selected offline tests, selected architecture documents, package manifests, and the source persona template.

Excluded: all `diagnostics/` raw and A/B material, `cloud-migration/` deployment material, live/real-model acceptance scripts, runtime `data/`, chat and Memory databases, Presence/Cognition state, sessions, reasoning raw, logs, backups, rollback snapshots, uploads, screenshots, recordings, TTS output, model weights, APKs, build products, `node_modules/`, the private portrait, and bundled voice samples. No binaries or non-UTF-8 files are included.

Mirror-only edits: private home paths were replaced with `os.homedir()` or environment-configurable paths in runtime and voice-worker code; test and documentation paths use example identities. The private portrait test now checks the fallback. A test credential literal was replaced with a placeholder and its expectation updated. `.env.example` contains only placeholder values.

Local pre-commit checks: static keyword review covered `sk-`, API key, token, secret, password, authorization, bearer, cookie, client secret, private key, Cloudflare, tunnel, and credential. Remaining occurrences are code identifiers, protocol headers, security tests, or public-service references. A local Gitleaks `detect --no-git` scan with redacted output found **0 leaks**. Private-identity, non-example email, private-host/IP, database/data, binary, and large-file checks found **0 actionable findings**.

Test status: `npm run check` passed. FPR unit tests and the unanswered proactive timeline test passed. The full Node offline suite stops at `scripts/natural-messaging-test.js:158` because that older proactive multi-bubble scenario returns `no_candidates`; the reviewer should inspect its setup against current inactivity eligibility. The Swift package compiled and all **165 tests passed** after adapting the missing portrait expectation. These results describe the audit copy, not production or candidate runtime acceptance.

License status: the source tree had no project `LICENSE`; this mirror does not add one. `NOTICE.third-party.md` documents architecture research. Third-party model, reference-audio, portrait, font, and other bundled assets are omitted; obtain any such asset separately under its own license.
