import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

process.env.COMPANION_BLOCK_REAL_UPSTREAM = "1";
process.env.UPSTREAM_BASE_URL = "http://127.0.0.1:9/v1";
for (const key of ["UPSTREAM_PRIMARY_BASE_URL", "UPSTREAM_SECONDARY_BASE_URL", "UPSTREAM_API_KEY", "TAVILY_API_KEY", "TAVILY_BASE_URL", "SEARXNG_BASE_URL"]) process.env[key] = "";
for (const key of ["UPSTREAM_CHAT_BASE_URL", "UPSTREAM_AGENT_BASE_URL", "UPSTREAM_SUMMARY_BASE_URL"]) process.env[key] = "http://127.0.0.1:9/v1";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "companion-wake-test-"));
const python = path.join(root, "python");
const model = path.join(root, "model");
const worker = path.join(root, "worker.py");
const voiceDir = path.join(root, "voice");
fs.writeFileSync(python, "fixture");
fs.mkdirSync(model);
fs.writeFileSync(worker, "fixture");
process.env.DATABASE_PATH = path.join(root, "db.sqlite");
process.env.COMPANION_VOICE_DIR = voiceDir;
process.env.COMPANION_INVOCATION_LEDGER_PATH = path.join(root, "ledger.jsonl");
process.env.COMPANION_INVOCATION_SUMMARY_PATH = path.join(root, "summary.json");
process.env.COMPANION_PRICING_REVISIONS_PATH = path.join(root, "prices.json");

const {
  stripWakePhrase, classifyWakeCommand, shouldListen, shouldResumeMicrophone,
  resolveWakeUtterance, sensitivityThreshold, gateDetections, persistUserText,
  DEFAULT_ENABLED, PERSIST_AMBIENT_AUDIO, CREATES_ATTENTION_ON_WAKE, PRODUCT_QUALIFIED,
  PRE_ROLL_SECONDS, overlayTitle
} = await import("../src/wake-word-policy.js");
const { LocalWakeWordService } = await import("../src/local-wake-word-service.js");
const { invocationLedger } = await import("../src/usage-ledger.js");

assert.equal(DEFAULT_ENABLED, false);
assert.equal(PERSIST_AMBIENT_AUDIO, false);
assert.equal(CREATES_ATTENTION_ON_WAKE, false);
assert.equal(PRODUCT_QUALIFIED, false);
assert.equal(PRE_ROLL_SECONDS, 0.9);
assert.equal(stripWakePhrase("林小糖帮我打开 TextEdit"), "帮我打开 TextEdit");
assert.equal(stripWakePhrase("林小糖，现在几点？"), "现在几点？");
assert.equal(stripWakePhrase("帮我打开 TextEdit"), "帮我打开 TextEdit");
assert.equal(classifyWakeCommand("林小糖，进入语音通话"), "start_call");
assert.equal(classifyWakeCommand("林小糖，进入通话"), "start_call");
assert.equal(classifyWakeCommand("林小糖，开始语音通话"), "start_call");
assert.equal(classifyWakeCommand("林小糖，跟我聊会儿"), "start_call");
assert.equal(classifyWakeCommand("林小糖，先别听了"), "disable_wake");
assert.equal(classifyWakeCommand("关闭唤醒"), "disable_wake");
assert.equal(classifyWakeCommand("暂停唤醒词"), "disable_wake");
assert.equal(classifyWakeCommand("算了"), "cancel");
assert.equal(classifyWakeCommand("没事了"), "cancel");
assert.equal(classifyWakeCommand("取消"), "cancel");
assert.equal(classifyWakeCommand("林小糖"), "empty");
assert.equal(classifyWakeCommand("林小糖，打开 TextEdit。"), "utterance");
assert.equal(persistUserText("utterance", "打开 TextEdit"), "打开 TextEdit");
assert.equal(persistUserText("cancel", "算了"), null);
assert.equal(persistUserText("empty", ""), null);
assert.equal(persistUserText("start_call", "进入语音通话"), null);
assert.deepEqual(shouldListen({ enabled: false }).state, "disabled");
assert.equal(shouldListen({ enabled: true }).listen, true);
assert.equal(shouldListen({ enabled: true, locked: true }).listen, false);
assert.equal(shouldListen({ enabled: true, sleeping: true }).reason, "sleep");
assert.equal(shouldListen({ enabled: true, voiceCallActive: true }).reason, "voice_call");
assert.equal(shouldListen({ enabled: true, assistantAudioPlaying: true }).listen, true);
assert.equal(shouldListen({ enabled: true, assistantAudioPlaying: true }).playback_gate, true);
assert.equal(shouldResumeMicrophone("launch", { enabled: true }), false);
assert.equal(shouldResumeMicrophone("sleep", { enabled: true }), false);
assert.equal(shouldResumeMicrophone("wake", { enabled: true }), false);
assert.equal(shouldResumeMicrophone("unlock", { enabled: true, locked: false, sleeping: false }), true);
assert.equal(shouldResumeMicrophone("unlock", { enabled: false }), false);
assert.equal(sensitivityThreshold("low"), 0.35);
assert.equal(sensitivityThreshold("normal"), 0.25);
assert.equal(sensitivityThreshold("high"), 0.18);
assert.equal(gateDetections([{ keyword: "林小糖" }], { assistantAudioPlaying: true }).length, 0);
assert.equal(gateDetections([{ keyword: "林小糖" }], { holdoffUntil: Date.now() + 1000 }).length, 0);
assert.equal(gateDetections([{ keyword: "林小糖" }]).length, 1);
assert.equal(overlayTitle("listening"), "等待唤醒");
assert.equal(resolveWakeUtterance("林小糖帮我打开 TextEdit").persist_user_text, "帮我打开 TextEdit");
assert.equal(resolveWakeUtterance("林小糖帮我打开 TextEdit").write_memory_raw, false);
assert.equal(resolveWakeUtterance("林小糖").command, "empty");

const cfg = {
  voiceDir,
  wakeWordPythonPath: python,
  wakeWordModelDir: model,
  wakeWordWorkerPath: worker,
  wakeWordLabRoot: root,
  wakeWordStartupTimeoutMs: 1000,
  wakeWordIngestTimeoutMs: 500
};

const disabled = new LocalWakeWordService({ config: cfg, fake: true });
assert.equal(disabled.publicStatus().enabled, false);
assert.equal(disabled.publicStatus().state, "disabled");
assert.equal(disabled.publicStatus().experimental, true);
assert.equal(disabled.publicStatus().product_qualified, false);
const disabledIngest = await disabled.ingest({ pcm16Base64: Buffer.alloc(32).toString("base64") });
assert.equal(disabledIngest.accepted, false);
assert.equal(JSON.stringify(disabled.publicStatus()).includes(root), false);

const fake = new LocalWakeWordService({ config: cfg, fake: true });
fake.updateSettings({ enabled: true, sensitivity: "normal" });
assert.equal(fake.settings.enabled, true);
const started = await fake.start();
assert.equal(started.state, "listening");
assert.equal(started.enabled, true);
assert.equal(fs.existsSync(path.join(voiceDir, "wake-word-settings.json")), true);
assert.equal(JSON.parse(fs.readFileSync(path.join(voiceDir, "wake-word-settings.json"), "utf8")).enabled, true);

fake.injectDetection("林小糖", 0.9);
const hit = await fake.ingest({ pcm16Base64: Buffer.alloc(64).toString("base64"), sampleRate: 16000 });
assert.equal(hit.accepted, true);
assert.equal(hit.detections[0].keyword, "林小糖");
fake.record("wake");
fake.record("one_shot");
assert.equal(fake.publicStatus().metrics.wake_detections, 1);
assert.equal(fake.publicStatus().metrics.one_shot_turns, 1);
assert.equal(fake.publicStatus().metrics.cost_usd, 0);
assert.equal(fake.publicStatus().metrics.input_tokens, 0);
assert.equal(fake.publicStatus().metrics.output_tokens, 0);
const usage = invocationLedger.snapshot().features.find(item => item.key === "local_wake_word");
assert.ok(usage);
assert.equal(usage.inputTokens, 0);
assert.equal(usage.outputTokens, 0);

fake.updateContext({ assistantAudioPlaying: true });
fake.injectDetection("林小糖", 0.9);
const gated = await fake.ingest({ pcm16Base64: Buffer.alloc(64).toString("base64") });
assert.equal(gated.accepted, true);
assert.equal(gated.gated, true);
assert.equal(gated.detections.length, 0);
fake.updateContext({ assistantAudioPlaying: false, holdoffMs: 400 });
const holdoff = await fake.ingest({ pcm16Base64: Buffer.alloc(64).toString("base64") });
assert.equal(holdoff.detections.length, 0);
fake.holdoffUntil = 0;

fake.updateContext({ voiceCallActive: true });
assert.equal(fake.publicStatus().state, "suspended");
const duringCall = await fake.ingest({ pcm16Base64: Buffer.alloc(64).toString("base64") });
assert.equal(duringCall.accepted, false);
fake.updateContext({ voiceCallActive: false });
assert.equal((await fake.start()).state, "listening");

fake.updateContext({ locked: true });
assert.equal(fake.publicStatus().state, "suspended");
fake.updateContext({ locked: false });
assert.equal((await fake.start()).state, "listening");

fake.updateContext({ sleeping: true });
assert.equal(fake.publicStatus().state, "suspended");
assert.equal(fake.shouldResume("wake"), false);
fake.updateContext({ sleeping: false });
assert.equal(fake.shouldResume("unlock"), true);
await fake.start();

assert.equal(fake.resolveTranscript("林小糖，进入语音通话").command, "start_call");
assert.equal(fake.resolveTranscript("林小糖，算了").command, "cancel");
assert.equal(fake.resolveTranscript("林小糖，先别听了").command, "disable_wake");
assert.equal(fake.resolveTranscript("林小糖").command, "empty");
fake.record("timeout");
fake.record("cancel");
fake.record("false_wake");
fake.record("call");
fake.record("disable");
assert.equal(fake.publicStatus().metrics.timeouts, 1);
assert.equal(fake.publicStatus().metrics.cancels, 1);
assert.equal(fake.publicStatus().metrics.false_wake_dismiss, 1);
assert.equal(fake.publicStatus().metrics.call_starts, 1);
assert.equal(fake.publicStatus().metrics.disable_commands, 1);

const persisted = JSON.stringify(JSON.parse(fs.readFileSync(path.join(voiceDir, "wake-word-metrics.json"), "utf8")));
assert.equal(persisted.includes("pcm"), false);
assert.equal(persisted.includes("audio"), false);
assert.equal(persisted.includes("林小糖帮我"), false);
const files = fake.durableFiles();
assert.equal(files.some(name => name.endsWith(".wav")), false);
assert.equal(files.some(name => name.includes("ambient")), false);

let child;
const fakeSpawn = (_exe, args, options) => {
  assert.deepEqual(args, ["-u", worker]);
  assert.equal(options.env.COMPANION_WAKE_WORD_MODEL, model);
  child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => child.emit("exit", 0);
  child.stdin.on("data", data => {
    const request = JSON.parse(String(data).trim().split("\n").pop());
    assert.equal("pcm16_base64" in request, true);
    assert.equal(JSON.stringify(request).includes("/Users/"), false);
    setImmediate(() => {
      if (request.type === "audio") {
        child.stdout.write(`${JSON.stringify({ type: "detection", keyword: "林小糖", score: 0.8 })}\n`);
        child.stdout.write(`${JSON.stringify({ type: "chunk_ok" })}\n`);
      }
    });
  });
  setImmediate(() => child.stdout.write(`${JSON.stringify({ type: "ready", engine: "sherpa-onnx" })}\n`));
  return child;
};
const live = new LocalWakeWordService({ config: cfg, spawn: fakeSpawn });
live.updateSettings({ enabled: true });
await live.start();
assert.equal(live.publicStatus().state, "listening");
const liveHit = await live.ingest({ pcm16Base64: Buffer.alloc(32).toString("base64"), sampleRate: 48000 });
assert.equal(liveHit.detections[0].keyword, "林小糖");
live.stop();
assert.equal(live.publicStatus().state, "suspended");
live.updateSettings({ enabled: false });
assert.equal(live.publicStatus().state, "disabled");
assert.equal(live.publicStatus().enabled, false);

const soak = new LocalWakeWordService({ config: cfg, fake: true });
soak.updateSettings({ enabled: true });
await soak.start();
const before = process.memoryUsage().rss;
for (let i = 0; i < 6000; i++) {
  soak.injectDetection();
  soak.updateContext({ assistantAudioPlaying: i % 200 === 0 });
  if (i % 200 !== 0) soak.updateContext({ assistantAudioPlaying: false });
  await soak.ingest({ pcm16Base64: Buffer.alloc(20).toString("base64") });
}
const after = process.memoryUsage().rss;
assert.ok(after - before < 80 * 1024 * 1024, "simulated 10-minute ingest must not grow unbounded");
soak.updateSettings({ enabled: false });
assert.equal(soak.publicStatus().state, "disabled");

const restarted = new LocalWakeWordService({ config: cfg, fake: true });
assert.equal(restarted.settings.enabled, false);
const enabledStore = new LocalWakeWordService({ config: { ...cfg, voiceDir: path.join(root, "persist") }, fake: true });
enabledStore.updateSettings({ enabled: true, sensitivity: "high", feedbackSound: false });
const reloaded = new LocalWakeWordService({ config: { ...cfg, voiceDir: path.join(root, "persist") }, fake: true });
assert.equal(reloaded.settings.enabled, true);
assert.equal(reloaded.settings.sensitivity, "high");
assert.equal(reloaded.settings.feedbackSound, false);

fs.rmSync(root, { recursive: true, force: true });
console.log("wake word runtime tests passed");
