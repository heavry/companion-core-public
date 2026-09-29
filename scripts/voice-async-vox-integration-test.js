/**
 * Voice Async v1 — real VoxCPMANE integration (8–12 serial turns).
 * Does not start a second primary Core. Uses the live :7862 worker only.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "companion-voice-vox-"));
process.env.COMPANION_API_KEY = "voice-async-vox-test-key-long-random";
process.env.DATABASE_PATH = path.join(tmp, "companion.db");
process.env.PERSONA_SYNC_ON_START = "true";
process.env.EMBEDDING_ENABLED = "false";
process.env.SUMMARY_EVERY_MESSAGES = "9999";
process.env.COMPANION_STATE_PATH = path.join(tmp, "companion-state.json");
process.env.COMPANION_BEHAVIOR_PATH = path.join(tmp, "companion-behavior.json");
process.env.COMPANION_AUTONOMOUS_LIFE_ENABLED = "false";
process.env.COMPANION_DEPLOYMENT_ROLE = "development-test";
process.env.COMPANION_VOXCPMANE_URL = process.env.COMPANION_VOXCPMANE_URL || "http://127.0.0.1:7862";
process.env.COMPANION_VOXCPMANE_VOICE = process.env.COMPANION_VOXCPMANE_VOICE || "linxt30";
process.env.COMPANION_TTS_PROVIDER_STATE = path.join(tmp, "tts-provider.json");
fs.writeFileSync(process.env.COMPANION_TTS_PROVIDER_STATE, JSON.stringify({ selected: "voxcpmane" }));

const { VoiceAsyncQueue, resetVoiceAsyncDiagnostics, snapshotVoiceAsyncDiagnostics } =
  await import("../src/voice-async-queue.js");
const { insertMessage, getMessageContentObject, getOrCreateSession, upsertPersona } =
  await import("../src/db.js");
const { synthesizeWithSelectedProvider } = await import("../src/tts-providers.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (m) => console.log(`OK  ${m}`);

upsertPersona({ id: "persona-vox", name: "林小糖", config_json: "{}" });
const session = getOrCreateSession("persona-vox", "chat", "vox-integration");

const TURNS = [
  { text: "我到啦，你那边顺利吗？", style: "neutral" },
  { text: "哼，你怎么才回我。", style: "angry" },
  { text: "有点难过……不过看到你就还好。", style: "sad" },
  { text: "太棒了！！我们真的做到了！", style: "happy" },
  { text: "嗯，我在。", style: "neutral" },
  { text: "刚想起来一件事，你昨天那个测试后来过了没？", style: "neutral" },
  { text: "好啦好啦，不气了。", style: "neutral" },
  { text: "等下给你看个东西。", style: "neutral" },
  { text: "今天好开心呀，想一直跟你说话。", style: "happy" },
  { text: "先这样，我眯一会儿。", style: "neutral" }
];

resetVoiceAsyncDiagnostics();
const timeline = [];
const queue = new VoiceAsyncQueue({
  synthesize: async ({ text, style, sessionId, signal }) => {
    timeline.push({ phase: "tts_start", text, style, at: Date.now() });
    const result = await synthesizeWithSelectedProvider({ text, style: style ?? "neutral", sessionId, signal });
    timeline.push({ phase: "tts_end", text, style, at: Date.now(), bytes: result.audio?.length ?? 0 });
    return { audio: result.audio, style: result.style ?? style, durationMs: result.durationMs };
  },
  onVoiceReady: async (payload) => {
    timeline.push({ phase: "ready", messageId: payload.message_id, shouldAutoplay: payload.should_autoplay, at: Date.now() });
  }
});

console.log(`VoxCPMANE=${process.env.COMPANION_VOXCPMANE_URL} voice=${process.env.COMPANION_VOXCPMANE_VOICE} turns=${TURNS.length}`);

for (const [index, turn] of TURNS.entries()) {
  const textDurableAt = Date.now();
  const messageId = insertMessage(session.id, "chat", {
    role: "assistant",
    content: turn.text,
    voice_job: { state: "pending", style: turn.style }
  });
  const textSseAt = Date.now();
  const queued = queue.enqueue({
    messageId,
    sessionId: session.id,
    text: turn.text,
    style: turn.style
  });
  assert.equal(queued.status, "QUEUED");
  timeline.push({ phase: "text", messageId, textDurableAt, textSseAt, index });

  // Wait for THIS message's voice so turns stay serial (like production queue).
  for (let i = 0; i < 200; i++) {
    const content = getMessageContentObject(messageId);
    if (content?.voice_job?.state === "ready" || content?.voice_job?.state === "failed") break;
    await sleep(100);
  }
  const content = getMessageContentObject(messageId);
  const textEvent = timeline.find((e) => e.phase === "text" && e.messageId === messageId);
  const readyEvent = timeline.find((e) => e.phase === "ready" && e.messageId === messageId);
  const ttsStart = timeline.find((e) => e.phase === "tts_start" && e.text === turn.text);
  const ttsEnd = timeline.find((e) => e.phase === "tts_end" && e.text === turn.text);

  assert.equal(content.text, turn.text, `turn ${index} text durable`);
  assert.equal(content.voice_job.state, "ready", `turn ${index} voice ready (${content.voice_job.error ?? ""})`);
  assert.ok(content.voice_asset?.voice_asset_id, `turn ${index} has canonical asset`);
  assert.equal(content.voice_asset.state, "ready");
  assert.equal(content.voice_job.style, turn.style, `turn ${index} style preserved`);
  assert.ok(textEvent.textSseAt <= ttsStart.at, `turn ${index} text SSE before TTS start`);
  assert.ok(ttsEnd && ttsEnd.bytes > 100, `turn ${index} real WAV bytes`);
  assert.ok(readyEvent, `turn ${index} voice_ready fired`);
  // No new user turn → should_autoplay true
  assert.equal(readyEvent.shouldAutoplay, true, `turn ${index} autoplay allowed while fresh`);
  console.log(`OK  ${index + 1}/${TURNS.length} ${turn.style} ready asset=${content.voice_asset.voice_asset_id.slice(0, 8)} bytes=${ttsEnd.bytes}`);
}

// Stale turn: user speaks, then late voice for old message must not autoplay
const oldId = insertMessage(session.id, "chat", { role: "assistant", content: "旧消息", voice_job: { state: "pending", style: "neutral" } });
// enqueue AFTER inserting a newer user message → should_autoplay false
insertMessage(session.id, "chat", { role: "user", content: "我已经继续说话了" });
const staleQueued = queue.enqueue({ messageId: oldId, sessionId: session.id, text: "旧消息", style: "neutral" });
assert.equal(staleQueued.status, "QUEUED");
for (let i = 0; i < 200; i++) {
  const c = getMessageContentObject(oldId);
  if (c?.voice_job?.state === "ready" || c?.voice_job?.state === "failed") break;
  await sleep(100);
}
const staleContent = getMessageContentObject(oldId);
const staleReady = timeline.find((e) => e.phase === "ready" && e.messageId === oldId);
assert.equal(staleContent.voice_job.state, "ready");
assert.equal(staleReady.shouldAutoplay, false, "stale ready must not autoplay");
ok("stale autoplay suppressed on real Vox path");

// Duplicate enqueue after ready
const dup = queue.enqueue({ messageId: oldId, sessionId: session.id, text: "旧消息" });
assert.equal(dup.status, "ALREADY_READY");
ok("ALREADY_READY after real asset");

await queue.waitForIdle();
const snap = snapshotVoiceAsyncDiagnostics();
assert.equal(snap.textBlockedByTtsCount, 0);
assert.equal(snap.staleVoiceAutoplay, 0);
assert.equal(snap.duplicateVoiceAsset, 0);
assert.equal(snap.duplicateBubble, 0);
assert.equal(snap.partialDurable, 0);
assert.ok(snap.voiceJobReady >= TURNS.length);
assert.ok(snap.ttsSynthesisLatency.count >= TURNS.length);
assert.ok(snap.voiceReadyLatency.p50 > 0);

console.log("\nVOICE ASYNC REAL VOXCPMANE INTEGRATION PASS");
console.log(JSON.stringify({
  turns: TURNS.length,
  voiceJobReady: snap.voiceJobReady,
  voiceJobFailed: snap.voiceJobFailed,
  textBlockedByTtsCount: snap.textBlockedByTtsCount,
  staleVoiceAutoplay: snap.staleVoiceAutoplay,
  duplicateVoiceAsset: snap.duplicateVoiceAsset,
  ttsSynthesisLatency: snap.ttsSynthesisLatency,
  voiceReadyLatency: snap.voiceReadyLatency
}, null, 2));
