#!/bin/sh
set -eu

export UPSTREAM_BASE_URL="http://127.0.0.1:9/v1"
export UPSTREAM_PRIMARY_BASE_URL=""
export UPSTREAM_SECONDARY_BASE_URL=""
export UPSTREAM_CHAT_BASE_URL="http://127.0.0.1:9/v1"
export UPSTREAM_AGENT_BASE_URL="http://127.0.0.1:9/v1"
export UPSTREAM_SUMMARY_BASE_URL="http://127.0.0.1:9/v1"
export UPSTREAM_SECONDARY_CHAT_BASE_URL=""
export UPSTREAM_SECONDARY_AGENT_BASE_URL=""
export UPSTREAM_SECONDARY_SUMMARY_BASE_URL=""
export UPSTREAM_API_KEY=""
export UPSTREAM_PRIMARY_API_KEY=""
export UPSTREAM_SECONDARY_API_KEY=""
export UPSTREAM_CHAT_API_KEY=""
export UPSTREAM_AGENT_API_KEY=""
export UPSTREAM_SUMMARY_API_KEY=""
export TAVILY_API_KEY=""
export TAVILY_BASE_URL=""
export SEARXNG_BASE_URL=""

npm run test:agent-v1
npm run test:session-permissions
npm run test:native-agent
npm run test:native-agent-streaming
npm run test:guidance-queue
npm run test:memory-engine
npm run test:memory-brain
npm run test:product-surfaces
npm run test:scheduler
npm run test:usage-ledger
npm run test:time-awareness
npm run test:chat-intimacy-stance
npm run test:policy
npm run test:memory-layers
npm run test:compat-unit
npm run test:responses-content
npm run test:routing
npm run test:integration
npm run test:responses
npm run test:compat
npm run test:providers
npm run test:provider-tool-schema
npm run test:module-framework
npm run test:module-permission
npm run test:module-triggers
npm run test:module-tools
npm run test:debug-leak
npm run test:module-idempotency
npm run test:module-ledger-persistence
npm run test:module-ledger-corruption
npm run test:proactive-followup
npm run test:proactive-cognition
npm run test:inactivity-proactive
npm run test:proactive-unanswered-timeline
npm run test:natural-messaging
npm run test:bubble-finalization
npm run test:natural-presence
npm run test:natural-cognition
npm run test:natural-diary
npm run test:natural-repair
npm run test:recent-episodes
npm run test:contact-suppression
npm run test:recent-utterances
npm run test:grounding-voice
npm run test:autonomous-life
npm run test:comfyui-media
npm run test:chat-media-web
npm run test:web-search
npm run test:network-resilience
npm run test:capability-registry
npm run test:autonomous-capabilities
npm run test:local-agent-runtime
npm run test:developer-operations
npm run test:self-maintenance
npm run test:package-operations
npm run test:local-runtime-controls
npm run test:local-voice
npm run test:voice-call
npm run test:wake-word
npm run test:attention
npm run test:voice-media
npm run test:tool-activity
npm run test:mcp-client
npm run test:mcp-oauth
npm run test:mcp-server
npm run test:weather-module
