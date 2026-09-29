import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { config } from "./config.js";
import { invocationLedger } from "./usage-ledger.js";
import {
  emptyWakeMetrics, gateDetections, resolveWakeUtterance, sensitivityThreshold,
  shouldListen, shouldResumeMicrophone, PRODUCT_QUALIFIED, WAKE_KEYWORDS_LINE, WAKE_PHRASE
} from "./wake-word-policy.js";

const cleanError = value => String(value?.message ?? value ?? "unknown").replace(/\/[A-Za-z0-9_.\-\u0080-\uFFFF/ ]+/g, "[local path]").slice(0, 240);
const MAX_CHUNK_BYTES = 256 * 1024;

export class LocalWakeWordService {
  constructor(options = {}) {
    this.cfg = { ...config, ...options.config };
    this.spawn = options.spawn ?? spawn;
    this.fake = options.fake === true;
    this.child = null;
    this.reader = null;
    this.state = "disabled";
    this.lastError = null;
    this.readyPromise = null;
    this.pendingChunk = null;
    this.queuedDetections = [];
    this.context = { locked: false, sleeping: false, voiceCallActive: false, assistantAudioPlaying: false };
    this.holdoffUntil = 0;
    this.listeningStartedAt = null;
    this.settingsPath = `${this.cfg.voiceDir}/wake-word-settings.json`;
    this.metricsPath = `${this.cfg.voiceDir}/wake-word-metrics.json`;
    this.keywordsPath = `${this.cfg.voiceDir}/wake-keywords.txt`;
    this.settings = this.loadSettings();
    this.metrics = this.loadMetrics();
  }

  loadSettings() {
    try {
      const v = JSON.parse(fs.readFileSync(this.settingsPath, "utf8"));
      return {
        enabled: v.enabled === true,
        sensitivity: ["low", "normal", "high"].includes(v.sensitivity) ? v.sensitivity : "normal",
        feedbackSound: v.feedbackSound !== false,
        suspendWhileLocked: v.suspendWhileLocked !== false
      };
    } catch {
      return { enabled: false, sensitivity: "normal", feedbackSound: true, suspendWhileLocked: true };
    }
  }

  persistSettings() {
    fs.mkdirSync(path.dirname(this.settingsPath), { recursive: true });
    const tmp = `${this.settingsPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, ...this.settings }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.settingsPath);
  }

  loadMetrics() {
    try { return { ...emptyWakeMetrics(), ...JSON.parse(fs.readFileSync(this.metricsPath, "utf8")) }; }
    catch { return emptyWakeMetrics(); }
  }

  persistMetrics() {
    fs.mkdirSync(path.dirname(this.metricsPath), { recursive: true });
    const tmp = `${this.metricsPath}.${process.pid}.tmp`;
    const safe = { ...this.metrics, cost_usd: 0, input_tokens: 0, output_tokens: 0 };
    delete safe.audio;
    delete safe.transcript;
    delete safe.pcm;
    fs.writeFileSync(tmp, JSON.stringify(safe, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.metricsPath);
  }

  configured() {
    if (this.fake) return true;
    return fs.existsSync(this.cfg.wakeWordPythonPath) && fs.existsSync(this.cfg.wakeWordWorkerPath) && fs.existsSync(this.cfg.wakeWordModelDir);
  }

  keywordsFile() {
    fs.mkdirSync(path.dirname(this.keywordsPath), { recursive: true });
    fs.writeFileSync(this.keywordsPath, `${WAKE_KEYWORDS_LINE}\n`, { mode: 0o600 });
    return this.keywordsPath;
  }

  publicStatus() {
    const decision = this.listenDecision();
    return {
      id: "voice.wake",
      phrase: WAKE_PHRASE,
      provider: "sherpa-onnx KWS",
      engine: "zipformer-wenetspeech-3.3M",
      license: "Apache-2.0",
      quantization: "int8",
      state: this.state,
      enabled: this.settings.enabled,
      sensitivity: this.settings.sensitivity,
      threshold: sensitivityThreshold(this.settings.sensitivity),
      feedback_sound: this.settings.feedbackSound,
      suspend_while_locked: this.settings.suspendWhileLocked,
      configured: this.configured(),
      ready: this.state === "listening",
      experimental: true,
      product_qualified: PRODUCT_QUALIFIED,
      local_only: true,
      persist_ambient_audio: false,
      last_error: this.lastError,
      listen: decision,
      metrics: { ...this.metrics, cost_usd: 0, input_tokens: 0, output_tokens: 0 }
    };
  }

  listenDecision(flags = {}) {
    return shouldListen({
      enabled: this.settings.enabled,
      suspendWhileLocked: this.settings.suspendWhileLocked,
      ...this.context,
      ...flags
    });
  }

  updateContext(input = {}) {
    if (typeof input.locked === "boolean") this.context.locked = input.locked;
    if (typeof input.sleeping === "boolean") this.context.sleeping = input.sleeping;
    if (typeof input.voiceCallActive === "boolean") this.context.voiceCallActive = input.voiceCallActive;
    if (typeof input.voice_call_active === "boolean") this.context.voiceCallActive = input.voice_call_active;
    if (typeof input.assistantAudioPlaying === "boolean") this.context.assistantAudioPlaying = input.assistantAudioPlaying;
    if (typeof input.assistant_audio_playing === "boolean") this.context.assistantAudioPlaying = input.assistant_audio_playing;
    if (typeof input.holdoffMs === "number") this.holdoffUntil = Date.now() + Math.max(0, input.holdoffMs);
    if (typeof input.holdoff_ms === "number") this.holdoffUntil = Date.now() + Math.max(0, input.holdoff_ms);
    return this.syncRuntime();
  }

  updateSettings(input = {}) {
    if (typeof input.enabled === "boolean") this.settings.enabled = input.enabled;
    if (["low", "normal", "high"].includes(input.sensitivity)) this.settings.sensitivity = input.sensitivity;
    if (typeof input.feedbackSound === "boolean") this.settings.feedbackSound = input.feedbackSound;
    if (typeof input.suspendWhileLocked === "boolean") this.settings.suspendWhileLocked = input.suspendWhileLocked;
    this.persistSettings();
    return this.syncRuntime();
  }

  syncRuntime() {
    this.flushListeningClock();
    const decision = this.listenDecision();
    if (!this.settings.enabled) {
      this.stop("disabled");
      return this.publicStatus();
    }
    if (!decision.listen) {
      this.stop("suspended");
      this.state = "suspended";
      return this.publicStatus();
    }
    if (this.state === "listening" && this.child) return this.publicStatus();
    this.start().catch(error => {
      this.lastError = cleanError(error);
      this.state = "error";
    });
    return this.publicStatus();
  }

  async start() {
    const decision = this.listenDecision();
    if (!this.settings.enabled) { this.stop("disabled"); return this.publicStatus(); }
    if (!decision.listen) { this.stop("suspended"); this.state = "suspended"; return this.publicStatus(); }
    if (this.child && this.state === "listening") return this.publicStatus();
    if (this.readyPromise) return this.readyPromise;
    if (!this.configured()) {
      this.state = "error";
      this.lastError = "local wake-word runtime is missing";
      throw Object.assign(new Error("local wake-word runtime is missing"), { code: "WAKE_RUNTIME_MISSING" });
    }
    this.state = "starting";
    this.lastError = null;
    if (this.fake) {
      this.state = "listening";
      this.listeningStartedAt = Date.now();
      return this.publicStatus();
    }
    this.readyPromise = new Promise((resolve, reject) => {
      const keywords = this.keywordsFile();
      const child = this.spawn(this.cfg.wakeWordPythonPath, ["-u", this.cfg.wakeWordWorkerPath], {
        cwd: this.cfg.wakeWordLabRoot || this.cfg.voiceDir,
        env: {
          ...process.env,
          COMPANION_WAKE_WORD_MODEL: this.cfg.wakeWordModelDir,
          COMPANION_WAKE_WORD_KEYWORDS: keywords,
          COMPANION_WAKE_WORD_THRESHOLD: String(sensitivityThreshold(this.settings.sensitivity)),
          PYTHONUNBUFFERED: "1"
        },
        stdio: ["pipe", "pipe", "pipe"]
      });
      this.child = child;
      let settled = false;
      const timeout = setTimeout(() => finish(new Error("wake-word startup timed out")), this.cfg.wakeWordStartupTimeoutMs || 15000);
      timeout.unref?.();
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) {
          this.lastError = cleanError(error);
          this.state = "error";
          reject(error);
        } else {
          this.state = "listening";
          this.listeningStartedAt = Date.now();
          resolve(this.publicStatus());
        }
      };
      this.reader = readline.createInterface({ input: child.stdout });
      this.reader.on("line", line => {
        let event;
        try { event = JSON.parse(line); } catch { return; }
        if (event.type === "ready") return finish();
        this.handleEvent(event);
      });
      child.stderr?.on("data", () => {});
      child.once("error", finish);
      child.once("exit", () => {
        const error = new Error("wake-word worker exited");
        if (this.pendingChunk) this.pendingChunk.reject(error);
        this.pendingChunk = null;
        this.child = null;
        this.reader = null;
        this.flushListeningClock();
        if (!["disabled", "suspended", "stopping"].includes(this.state)) {
          this.state = "error";
          this.lastError = cleanError(error);
        }
        finish(error);
      });
    }).finally(() => { this.readyPromise = null; });
    return this.readyPromise;
  }

  handleEvent(event) {
    if (event.type === "detection") {
      this.queuedDetections.push({ keyword: event.keyword || WAKE_PHRASE, score: Number(event.score) || 0 });
      return;
    }
    if (event.type === "chunk_ok" && this.pendingChunk) {
      const pending = this.pendingChunk;
      this.pendingChunk = null;
      pending.resolve(true);
    }
    if (event.type === "error" && this.pendingChunk) {
      const pending = this.pendingChunk;
      this.pendingChunk = null;
      pending.reject(new Error(event.message || "wake-word chunk failed"));
    }
  }

  async ingest({ pcm16Base64 = "", sampleRate = 16000 } = {}) {
    const decision = this.listenDecision();
    if (!decision.listen || this.state !== "listening") {
      return { accepted: false, detections: [], state: this.state };
    }
    if (this.context.assistantAudioPlaying || Date.now() < this.holdoffUntil) {
      this.queuedDetections = [];
      return { accepted: true, detections: [], gated: true, state: this.state };
    }
    const audio = Buffer.from(String(pcm16Base64), "base64");
    if (audio.length === 0) return { accepted: true, detections: [], state: this.state };
    if (audio.length > MAX_CHUNK_BYTES) throw Object.assign(new Error("wake-word chunk is too large"), { code: "WAKE_CHUNK_TOO_LARGE" });
    if (this.fake && !this.child) {
      return { accepted: true, detections: gateDetections(this.queuedDetections.splice(0), { assistantAudioPlaying: this.context.assistantAudioPlaying, holdoffUntil: this.holdoffUntil }), state: this.state };
    }
    await this.start();
    const detections = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingChunk = null;
        reject(Object.assign(new Error("wake-word ingest timed out"), { code: "WAKE_INGEST_TIMEOUT" }));
      }, this.cfg.wakeWordIngestTimeoutMs || 800);
      timeout.unref?.();
      this.queuedDetections = [];
      this.pendingChunk = {
        resolve: () => {
          clearTimeout(timeout);
          resolve(this.queuedDetections.splice(0));
        },
        reject: error => {
          clearTimeout(timeout);
          reject(error);
        }
      };
      this.child.stdin.write(`${JSON.stringify({ type: "audio", pcm16_base64: audio.toString("base64"), sample_rate: Number(sampleRate) || 16000 })}\n`);
    });
    const gated = gateDetections(detections, {
      assistantAudioPlaying: this.context.assistantAudioPlaying,
      holdoffUntil: this.holdoffUntil
    });
    return { accepted: true, detections: gated, state: this.state };
  }

  injectDetection(keyword = WAKE_PHRASE, score = 0.9) {
    this.queuedDetections.push({ keyword, score });
    return this.queuedDetections.slice();
  }

  resolveTranscript(text = "") {
    return resolveWakeUtterance(text);
  }

  record(kind) {
    if (kind === "wake") this.metrics.wake_detections++;
    if (kind === "one_shot") this.metrics.one_shot_turns++;
    if (kind === "timeout") this.metrics.timeouts++;
    if (kind === "cancel") this.metrics.cancels++;
    if (kind === "false_wake") this.metrics.false_wake_dismiss++;
    if (kind === "call") this.metrics.call_starts++;
    if (kind === "disable") this.metrics.disable_commands++;
    this.persistMetrics();
    invocationLedger.append({
      provider: "local",
      model: "wake-word-kws",
      publicModel: "voice.wake",
      feature: "local_wake_word",
      source: "native",
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      usageSource: "non_model",
      durationMs: 0,
      success: true
    });
    return this.publicStatus();
  }

  shouldResume(event) {
    return shouldResumeMicrophone(event, { enabled: this.settings.enabled, ...this.context });
  }

  flushListeningClock() {
    if (!this.listeningStartedAt) return;
    this.metrics.listening_seconds += Math.max(0, (Date.now() - this.listeningStartedAt) / 1000);
    this.listeningStartedAt = this.state === "listening" ? Date.now() : null;
    this.persistMetrics();
  }

  durableFiles() {
    return fs.existsSync(this.cfg.voiceDir)
      ? fs.readdirSync(this.cfg.voiceDir).filter(name => !name.endsWith(".tmp"))
      : [];
  }

  stop(next = null) {
    this.flushListeningClock();
    try { this.child?.kill("SIGTERM"); } catch {}
    try { this.reader?.close(); } catch {}
    this.child = null;
    this.reader = null;
    this.pendingChunk = null;
    this.queuedDetections = [];
    if (next) this.state = next;
    else this.state = this.settings.enabled ? "suspended" : "disabled";
    if (!this.settings.enabled) this.state = "disabled";
    return this.publicStatus();
  }
}

export const localWakeWordService = new LocalWakeWordService();
export { shouldListen, sensitivityThreshold, resolveWakeUtterance, shouldResumeMicrophone };
