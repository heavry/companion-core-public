/**
 * Voice Async v1 — Core targeted tests (12–15 scenarios).
 * textBlockedByTtsCount / duplicateVoiceAsset / duplicateBubble / partialDurable must stay 0.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "companion-voice-async-"));
process.env.COMPANION_API_KEY = "voice-async-test-key-long-random";
process.env.DATABASE_PATH = path.join(tmp, "companion.db");
process.env.PERSONA_SYNC_ON_START = "true";
process.env.EMBEDDING_ENABLED = "false";
process.env.SUMMARY_EVERY_MESSAGES = "9999";
process.env.COMPANION_STATE_PATH = path.join(tmp, "companion-state.json");
process.env.COMPANION_BEHAVIOR_PATH = path.join(tmp, "companion-behavior.json");
process.env.COMPANION_AUTONOMOUS_LIFE_ENABLED = "false";
process.env.COMPANION_MODALITY_PLANNER_ENABLED = "true";
process.env.COMPANION_DEPLOYMENT_ROLE = "local-primary";

const {
  VoiceAsyncQueue,
  voiceAttemptKey,
  voiceAsyncDiagnostics,
  resetVoiceAsyncDiagnostics,
  snapshotVoiceAsyncDiagnostics,
  shouldAutoplayVoice
} = await import("../src/voice-async-queue.js");
const {
  insertMessage,
  getMessageContentObject,
  mergeMessageContentJson,
  hasUserMessageAfter,
  getOrCreateSession,
  upsertPersona,
  findVoiceJobByAttemptKey
} = await import("../src/db.js");
const { deliverBubbleSequence } = await import("../src/natural-messaging.js");
const { publicVoiceAsset } = await import("../src/voice-message-delivery.js");

function wav(seconds = 0.5, sampleRate = 8000) {
  const dataBytes = Math.round(seconds * sampleRate * 2);
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

const ok = (m) => console.log(`OK  ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

upsertPersona({ id: "persona-va", name: "林小糖", config_json: "{}" });
const session = getOrCreateSession("persona-va", "chat", "voice-async-session");

resetVoiceAsyncDiagnostics();

// --- 1. normal async: text first, then ready ---
{
  resetVoiceAsyncDiagnostics();
  const order = [];
  const queue = new VoiceAsyncQueue({
    synthesize: async ({ text }) => {
      order.push("tts");
      await sleep(30);
      return { audio: wav(0.4), style: "neutral" };
    },
    onVoiceReady: async () => order.push("ready")
  });
  const messageId = insertMessage(session.id, "chat", {
    role: "assistant",
    content: "正常异步语音",
    voice_job: { state: "pending", style: "neutral" }
  });
  order.push("text_durable");
  // Production: text SSE first, then enqueue TTS.
  order.push("text_sse");
  const queued = queue.enqueue({ messageId, sessionId: session.id, text: "正常异步语音", style: "neutral" });
  assert.equal(queued.status, "QUEUED");
  assert.equal(order[0], "text_durable");
  assert.equal(order[1], "text_sse", "text SSE before TTS enqueue");
  await queue.waitForIdle();
  assert.ok(order.indexOf("text_sse") < order.indexOf("tts"));
  assert.ok(order.indexOf("tts") < order.indexOf("ready"));
  const content = getMessageContentObject(messageId);
  assert.equal(content.voice_job.state, "ready");
  assert.ok(content.voice_asset?.voice_asset_id);
  assert.equal(content.text, "正常异步语音");
  assert.equal(voiceAsyncDiagnostics.textBlockedByTtsCount, 0);
  ok("1 normal async text-before-voice");
}

// --- 2. slow TTS 8–15s (simulated 200ms stand-in still proves non-block) ---
{
  resetVoiceAsyncDiagnostics();
  let textSeenAt = 0;
  let ttsStartedAt = 0;
  const queue = new VoiceAsyncQueue({
    synthesize: async () => {
      ttsStartedAt = Date.now();
      await sleep(200);
      return { audio: wav(0.2) };
    }
  });
  const messageId = insertMessage(session.id, "chat", { role: "assistant", content: "慢速合成" });
  const t0 = Date.now();
  queue.enqueue({ messageId, sessionId: session.id, text: "慢速合成" });
  textSeenAt = Date.now();
  assert.ok(textSeenAt - t0 < 50, "text path returns before TTS");
  await queue.waitForIdle();
  assert.ok(ttsStartedAt >= textSeenAt - 5);
  ok("2 slow TTS does not block text");
}

// --- 3. TTS failure keeps text ---
{
  resetVoiceAsyncDiagnostics();
  const queue = new VoiceAsyncQueue({
    synthesize: async () => {
      throw Object.assign(new Error("VoxCPMANE 500"), { code: "TTS_UNAVAILABLE" });
    }
  });
  const messageId = insertMessage(session.id, "chat", { role: "assistant", content: "失败也保留文字" });
  queue.enqueue({ messageId, sessionId: session.id, text: "失败也保留文字" });
  await queue.waitForIdle();
  const content = getMessageContentObject(messageId);
  assert.equal(content.text, "失败也保留文字");
  assert.equal(content.voice_job.state, "failed");
  assert.equal(content.voice_asset, undefined);
  assert.equal(voiceAsyncDiagnostics.voiceJobFailed, 1);
  assert.equal(voiceAsyncDiagnostics.textBlockedByTtsCount, 0);
  ok("3 TTS failure keeps text");
}

// --- 4. Bubble1 + Bubble2: both text immediate, Bubble2 text never waits TTS1 ---
{
  resetVoiceAsyncDiagnostics();
  const timeline = [];
  let synthCount = 0;
  const queue = new VoiceAsyncQueue({
    synthesize: async ({ text }) => {
      synthCount++;
      timeline.push(`tts_start:${text}`);
      // slower than IM inter-bubble delay so Bubble2 text must not wait for TTS1
      await sleep(700);
      timeline.push(`tts_end:${text}`);
      return { audio: wav(0.15) };
    }
  });
  const seq = await deliverBubbleSequence({
    sessionId: session.id,
    bubbles: ["气泡一", "气泡二"],
    generationRoute: "natural_chat",
    turnId: `${session.id}:t-bubbles`,
    enableModality: true,
    forceModality: "VOICE",
    userModality: "text",
    enqueueVoice: (p) => {
      timeline.push(`enqueue:${p.text}`);
      return queue.enqueue(p);
    },
    onDelivered: async ({ text }) => {
      timeline.push(`text_sse:${text}`);
    }
  });
  assert.equal(seq.messages.length, 2);
  const i1 = timeline.indexOf("text_sse:气泡一");
  const i2 = timeline.indexOf("text_sse:气泡二");
  const s1 = timeline.indexOf("tts_start:气泡一");
  assert.ok(i1 >= 0 && i2 >= 0 && s1 >= 0, JSON.stringify(timeline));
  // Both texts durable+SSE before this function returns — TTS still running.
  assert.ok(i1 < s1, `bubble1 text before tts start: ${timeline.join(",")}`);
  // When all texts are out, TTS1 must still be pending (text never awaits TTS).
  assert.equal(timeline.includes("tts_end:气泡一"), false, `TTS1 still running when texts done: ${timeline.join(",")}`);
  assert.equal(timeline.includes("tts_end:气泡二"), false, `TTS2 still running when texts done: ${timeline.join(",")}`);
  await queue.waitForIdle();
  assert.equal(synthCount, 2);
  const t1 = timeline.indexOf("tts_end:气泡一");
  const t2 = timeline.indexOf("tts_end:气泡二");
  assert.ok(i1 < t1 && i2 < t2, `both texts before their voice ready: ${timeline.join(",")}`);
  ok("4 Bubble1+Bubble2 text never waits on TTS");
}

// --- 5. duplicate enqueue suppressed ---
{
  resetVoiceAsyncDiagnostics();
  let calls = 0;
  const queue = new VoiceAsyncQueue({
    synthesize: async () => {
      calls++;
      await sleep(20);
      return { audio: wav(0.1) };
    }
  });
  const messageId = insertMessage(session.id, "chat", { role: "assistant", content: "重复入队" });
  const a = queue.enqueue({ messageId, sessionId: session.id, text: "重复入队" });
  const b = queue.enqueue({ messageId, sessionId: session.id, text: "重复入队" });
  assert.equal(a.status, "QUEUED");
  assert.equal(b.status, "DUPLICATE_SUPPRESSED");
  await queue.waitForIdle();
  // after ready, third enqueue is ALREADY_READY
  const c = queue.enqueue({ messageId, sessionId: session.id, text: "重复入队" });
  assert.equal(c.status, "ALREADY_READY");
  assert.equal(calls, 1);
  assert.equal(voiceAsyncDiagnostics.voiceJobDuplicateSuppressed >= 2, true);
  ok("5 duplicate enqueue + ALREADY_READY");
}

// --- 6. restart before ready: re-queue without duplicate text ---
{
  resetVoiceAsyncDiagnostics();
  const messageId = insertMessage(session.id, "chat", {
    role: "assistant",
    content: "重启前排队",
    voice_job: { attempt_key: voiceAttemptKey(999), state: "queued", style: "neutral" }
  });
  // fix attempt_key to this message
  mergeMessageContentJson(messageId, { voice_job: { attempt_key: voiceAttemptKey(messageId), state: "queued" } });
  let calls = 0;
  const queue = new VoiceAsyncQueue({
    synthesize: async () => {
      calls++;
      return { audio: wav(0.1) };
    }
  });
  const recovered = queue.recoverPending();
  await queue.waitForIdle();
  const content = getMessageContentObject(messageId);
  assert.equal(content.text, "重启前排队");
  assert.equal(content.voice_job.state, "ready");
  assert.ok(content.voice_asset?.voice_asset_id);
  assert.equal(calls, 1);
  assert.ok(recovered.recovered >= 1);
  ok("6 restart before ready re-queues voice only");
}

// --- 7. restart after ready: no re-synth ---
{
  resetVoiceAsyncDiagnostics();
  const messageId = insertMessage(session.id, "chat", {
    role: "assistant",
    content: "重启后已就绪",
    voice_asset: { voice_asset_id: "already-ready-asset", duration: 1, state: "ready", url: "/media/x" },
    voice_job: { attempt_key: "voice:x:1", state: "ready" }
  });
  let calls = 0;
  const queue = new VoiceAsyncQueue({
    synthesize: async () => {
      calls++;
      return { audio: wav(0.1) };
    }
  });
  queue.recoverPending();
  await queue.waitForIdle();
  const again = queue.enqueue({ messageId, sessionId: session.id, text: "重启后已就绪" });
  assert.equal(again.status, "ALREADY_READY");
  assert.equal(calls, 0);
  ok("7 restart after ready no re-synth");
}

// --- 8. stale user turn → should_autoplay false ---
{
  resetVoiceAsyncDiagnostics();
  const queue = new VoiceAsyncQueue({ synthesize: async () => ({ audio: wav(0.1) }) });
  const messageId = insertMessage(session.id, "chat", { role: "assistant", content: "旧消息语音" });
  insertMessage(session.id, "chat", { role: "user", content: "用户已经继续聊了" });
  assert.equal(hasUserMessageAfter(session.id, messageId), true);
  assert.equal(shouldAutoplayVoice(session.id, messageId), false);
  let readyPayload = null;
  queue.onVoiceReady = async (p) => { readyPayload = p; };
  queue.enqueue({ messageId, sessionId: session.id, text: "旧消息语音" });
  await queue.waitForIdle();
  assert.equal(readyPayload.should_autoplay, false);
  assert.ok(readyPayload.voice_asset?.voice_asset_id);
  assert.equal(voiceAsyncDiagnostics.staleVoiceAutoplay, 0, "no stale autoplay violation");
  ok("8 stale user turn suppresses autoplay");
}

// --- 9. NO VOICE plan: no job ---
{
  resetVoiceAsyncDiagnostics();
  let calls = 0;
  const queue = new VoiceAsyncQueue({
    synthesize: async () => {
      calls++;
      return { audio: wav(0.1) };
    }
  });
  const seq = await deliverBubbleSequence({
    sessionId: session.id,
    bubbles: ["纯文字"],
    generationRoute: "natural_chat",
    turnId: `${session.id}:t-novoice`,
    enableModality: true,
    forceModality: "TEXT",
    userModality: "text",
    enqueueVoice: (p) => queue.enqueue(p),
    onDelivered: async () => {}
  });
  await queue.waitForIdle();
  assert.equal(calls, 0, "no TTS when modality is TEXT");
  const content = getMessageContentObject(seq.messages[0].messageId);
  assert.equal(content.voice_job, undefined);
  ok("9 NO VOICE plan");
}

// --- 10. proactive voice: same async path ---
{
  resetVoiceAsyncDiagnostics();
  const queue = new VoiceAsyncQueue({ synthesize: async () => ({ audio: wav(0.1) }) });
  const messageId = insertMessage(session.id, "proactive", {
    role: "assistant",
    content: "主动消息语音",
    proactive_attempt_key: "proactive:test:1"
  });
  queue.enqueue({ messageId, sessionId: session.id, text: "主动消息语音", style: "happy", source: "proactive" });
  await queue.waitForIdle();
  const content = getMessageContentObject(messageId);
  assert.equal(content.voice_job.state, "ready");
  assert.equal(content.proactive_attempt_key, "proactive:test:1", "merge keeps proactive key");
  assert.equal(content.text, "主动消息语音");
  ok("10 proactive voice async");
}

// --- 11. style preservation ---
{
  resetVoiceAsyncDiagnostics();
  let gotStyle = null;
  const queue = new VoiceAsyncQueue({
    synthesize: async ({ style }) => {
      gotStyle = style;
      return { audio: wav(0.1) };
    }
  });
  const messageId = insertMessage(session.id, "chat", {
    role: "assistant",
    content: "带风格",
    voice_plan: { schema_version: 1, voice_style: "angry", voice_profile: "linxt30", text: "带风格", voice_requested: true }
  });
  queue.enqueue({ messageId, sessionId: session.id, text: "带风格", style: "angry", voicePlan: { voice_style: "angry" } });
  await queue.waitForIdle();
  assert.equal(gotStyle, "angry");
  const content = getMessageContentObject(messageId);
  assert.equal(content.voice_plan.voice_style, "angry");
  assert.equal(content.voice_job.style, "angry");
  ok("11 style metadata preserved");
}

// --- 12. content_json merge safety ---
{
  resetVoiceAsyncDiagnostics();
  const messageId = insertMessage(session.id, "chat", {
    role: "assistant",
    content: "合并安全",
    bubble_index: 0,
    bubble_count: 2,
    bubble_turn_id: "turn-merge",
    generation_route: "post_message_followup",
    origin: "post_message_followup",
    post_message: { attempt_key: "postmsg:turn-merge:1", reason_code: "memory_afterthought" },
    voice_plan: { voice_style: "sad", voice_requested: true }
  });
  const queue = new VoiceAsyncQueue({ synthesize: async () => ({ audio: wav(0.1) }) });
  queue.enqueue({ messageId, sessionId: session.id, text: "合并安全", style: "sad" });
  await queue.waitForIdle();
  const content = getMessageContentObject(messageId);
  assert.equal(content.text, "合并安全");
  assert.equal(content.bubble_index, 0);
  assert.equal(content.bubble_count, 2);
  assert.equal(content.bubble_turn_id, "turn-merge");
  assert.equal(content.origin, "post_message_followup");
  assert.equal(content.post_message.attempt_key, "postmsg:turn-merge:1");
  assert.equal(content.voice_plan.voice_style, "sad");
  assert.equal(content.voice_job.state, "ready");
  assert.ok(content.voice_asset?.voice_asset_id);
  ok("12 content_json merge safety");
}

// --- 13. canonical identity voice:<message_id>:1 ---
{
  const messageId = insertMessage(session.id, "chat", { role: "assistant", content: "身份" });
  assert.equal(voiceAttemptKey(messageId), `voice:${messageId}:1`);
  const queue = new VoiceAsyncQueue({ synthesize: async () => ({ audio: wav(0.1) }) });
  queue.enqueue({ messageId, sessionId: session.id, text: "身份" });
  await queue.waitForIdle();
  const row = findVoiceJobByAttemptKey(voiceAttemptKey(messageId));
  assert.equal(Number(row.id), messageId);
  ok("13 canonical attempt_key identity");
}

// --- 14. metrics snapshot invariants ---
{
  const snap = snapshotVoiceAsyncDiagnostics();
  assert.equal(snap.textBlockedByTtsCount, 0);
  assert.equal(snap.staleVoiceAutoplay, 0);
  assert.equal(snap.duplicateBubble, 0);
  assert.equal(snap.partialDurable, 0);
  assert.ok(snap.voiceJobQueued >= 1);
  assert.ok(snap.voiceJobReady >= 1);
  assert.ok(snap.ttsSynthesisLatency.count >= 1);
  ok("14 metrics invariants");
}

// --- 15. voice asset attach + durable source of truth (not SSE) ---
{
  resetVoiceAsyncDiagnostics();
  let ssePayloads = [];
  const queue = new VoiceAsyncQueue({
    synthesize: async () => ({ audio: wav(0.2) }),
    onVoiceReady: async (p) => ssePayloads.push(p)
  });
  const messageId = insertMessage(session.id, "chat", { role: "assistant", content: "真相在 DB" });
  queue.enqueue({ messageId, sessionId: session.id, text: "真相在 DB" });
  await queue.waitForIdle();
  // simulate SSE loss: clear sinks, reload from DB
  ssePayloads = [];
  const content = getMessageContentObject(messageId);
  assert.ok(content.voice_asset?.voice_asset_id, "reload recovers durable asset");
  assert.equal(content.voice_asset.state, "ready");
  assert.equal(content.voice_job.state, "ready");
  ok("15 durable voice_asset is source of truth");
}

console.log("\nVOICE ASYNC V1 CORE TARGETED PASS");
console.log(JSON.stringify(snapshotVoiceAsyncDiagnostics(), null, 2));
