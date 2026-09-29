# Companion Core — public architecture audit snapshot

Companion Core is a long-term AI companion and local agent. The Node.js core owns conversations, persona, memory, proactive scheduling, reasoning continuity, tools, voice orchestration, and persistence. A Swift macOS client provides chat, voice, settings, and computer-use surfaces.

This repository is a **sanitized, single-commit snapshot** of stable candidate source commit `3f4991a`. It is intended for independent architecture and code review. It is not a deployment artifact and contains no live user database, conversations, credentials, model weights, or original Git history. See [CLAUDE_REVIEW_BRIEF.md](CLAUDE_REVIEW_BRIEF.md) for review scope and [docs/architecture.md](docs/architecture.md) for a code map.

## Local development

Requirements: Node.js 22.5 or newer, npm, and (for the optional Mac app) macOS with Swift 5.9 or newer.

```sh
npm ci
cp .env.example .env
# Edit .env with your own development values.
npm start
```

The example uses localhost on port 8765. Required configuration names are `COMPANION_API_KEY`, `UPSTREAM_BASE_URL`, `UPSTREAM_API_KEY`, `UPSTREAM_CHAT_MODEL`, and `UPSTREAM_AGENT_MODEL`. `UPSTREAM_SUMMARY_MODEL` is optional. No supplied key or upstream URL is usable. Run the offline checks with `npm test`; optional provider, voice, and GUI features need their own local services and assets.

The Mac client is under `CompanionMac/`. Run it with Swift tooling after configuring its local Core endpoint and credentials. The portrait asset was deliberately removed, so the client uses its fallback presentation.

## What is omitted

All runtime data and history are absent: SQLite databases, Memory and Presence state, sessions, messages, reasoning raw, diagnostics/traces, backups, logs, uploaded media, screenshots, recordings, TTS output, models and weights, APKs, build outputs, and `node_modules`. Deployment-specific cloud migration material, live acceptance scripts, and private configuration were also omitted. Third-party model, reference-audio, and portrait assets must be obtained separately under their own licenses. The source contains integration code and placeholders for them.

The original project has **no project LICENSE** at this snapshot. No new license is granted by this mirror. Third-party architecture research attribution is in [NOTICE.third-party.md](NOTICE.third-party.md); bundled third-party assets are not included.
