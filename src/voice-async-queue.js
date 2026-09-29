/**
 * Voice Async v1 — text-first, TTS never blocks text delivery.
 *
 * Canonical identity: voice:<assistant_message_id>:1
 * Durable state lives in messages.content_json.voice_job + voice_asset.
 * SSE is never the source of truth.
 */

import {
  getMessageById,
  getMessageContentObject,
  mergeMessageContentJson,
  hasUserMessageAfter,
  listPendingVoiceJobMessages
} from "./db.js";
import { publishEvent } from "./events-bus.js";
import { attachMediaToMessage, saveVoiceMedia } from "./media.js";
import { publicVoiceAsset, wavDurationSeconds } from "./voice-message-delivery.js";

export function voiceAttemptKey(messageId) {
  return `voice:${Number(messageId)}:1`;
}

export const voiceAsyncDiagnostics = {
  voiceEligibleCount: 0,
  voiceJobQueued: 0,
  voiceJobStarted: 0,
  voiceJobReady: 0,
  voiceJobFailed: 0,
  voiceJobCancelled: 0,
  voiceJobStale: 0,
  voiceJobDuplicateSuppressed: 0,
  textBeforeVoiceReadyCount: 0,
  textBlockedByTtsCount: 0,
  staleVoiceAutoplay: 0,
  staleVoiceAutoplaySuppressed: 0,
  duplicateVoiceAsset: 0,
  voiceReadyAfterReconnect: 0,
  duplicateBubble: 0,
  partialDurable: 0,
  ttsQueueWaitMs: [],
  ttsSynthesisLatencyMs: [],
  voiceReadyLatencyMs: [],
  lastAttemptKey: null,
  lastState: null
};

export function resetVoiceAsyncDiagnostics() {
  for (const key of Object.keys(voiceAsyncDiagnostics)) {
    if (Array.isArray(voiceAsyncDiagnostics[key])) voiceAsyncDiagnostics[key] = [];
    else if (key === "lastAttemptKey" || key === "lastState") voiceAsyncDiagnostics[key] = null;
    else voiceAsyncDiagnostics[key] = 0;
  }
}

function latencyPush(list, ms) {
  if (!Array.isArray(list) || !Number.isFinite(ms)) return;
  list.push(Math.round(ms));
  if (list.length > 200) list.shift();
}

function latencySummary(list) {
  const values = (list ?? []).filter(x => Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (!values.length) return { count: 0, p50: null, p95: null, max: null };
  const p = (q) => values[Math.min(values.length - 1, Math.floor(q * (values.length - 1)))];
  return { count: values.length, p50: p(0.5), p95: p(0.95), max: values[values.length - 1] };
}

export function snapshotVoiceAsyncDiagnostics() {
  return {
    ...voiceAsyncDiagnostics,
    ttsQueueWait: latencySummary(voiceAsyncDiagnostics.ttsQueueWaitMs),
    ttsSynthesisLatency: latencySummary(voiceAsyncDiagnostics.ttsSynthesisLatencyMs),
    voiceReadyLatency: latencySummary(voiceAsyncDiagnostics.voiceReadyLatencyMs)
  };
}

export function shouldAutoplayVoice(sessionId, messageId) {
  return !hasUserMessageAfter(sessionId, messageId);
}

async function defaultSynthesize({ text, style, sessionId, signal }) {
  const { synthesizeAssistantBubble } = await import("./assistant-voice-bubble.js");
  return synthesizeAssistantBubble({ text, style, sessionId, signal });
}

export class VoiceAsyncQueue {
  constructor({ synthesize = null, onVoiceReady = null, now = () => Date.now() } = {}) {
    this.synthesize = synthesize ?? defaultSynthesize;
    this.onVoiceReady = onVoiceReady;
    this.now = now;
    this.queue = [];
    this.running = false;
    this.inFlight = new Set();
    this.completed = new Set();
  }

  enqueue({
    messageId,
    sessionId,
    text,
    style = "neutral",
    voicePlan = null,
    voiceStyle = null,
    emotion = null,
    signal = null,
    source = "chat",
    now = this.now
  } = {}) {
    const id = Number(messageId);
    if (!Number.isFinite(id) || id <= 0) {
      voiceAsyncDiagnostics.partialDurable++;
      return { status: "NO_MESSAGE", attempt_key: null };
    }
    const attemptKey = voiceAttemptKey(id);
    const row = getMessageById(id);
    if (!row) {
      voiceAsyncDiagnostics.partialDurable++;
      return { status: "NO_MESSAGE", attempt_key: attemptKey, message_id: id };
    }

    const content = getMessageContentObject(id) ?? {};
    const existingAsset = content.voice_asset && typeof content.voice_asset === "object" ? content.voice_asset : null;
    const job = content.voice_job && typeof content.voice_job === "object" ? content.voice_job : null;

    if (existingAsset?.voice_asset_id && (existingAsset.state ?? "ready") === "ready") {
      voiceAsyncDiagnostics.voiceJobDuplicateSuppressed++;
      if (!job || job.state !== "ready") {
        mergeMessageContentJson(id, {
          voice_job: {
            attempt_key: attemptKey,
            state: "ready",
            ready_at: job?.ready_at ?? new Date(now()).toISOString()
          }
        });
      }
      voiceAsyncDiagnostics.lastAttemptKey = attemptKey;
      voiceAsyncDiagnostics.lastState = "ALREADY_READY";
      return {
        status: "ALREADY_READY",
        attempt_key: attemptKey,
        message_id: id,
        voice_asset: existingAsset,
        should_autoplay: false
      };
    }

    if (job?.attempt_key === attemptKey && job.state === "ready") {
      voiceAsyncDiagnostics.voiceJobDuplicateSuppressed++;
      voiceAsyncDiagnostics.lastAttemptKey = attemptKey;
      voiceAsyncDiagnostics.lastState = "ALREADY_READY";
      return {
        status: "ALREADY_READY",
        attempt_key: attemptKey,
        message_id: id,
        voice_asset: existingAsset,
        should_autoplay: false
      };
    }

    if (this.inFlight.has(attemptKey) || this.completed.has(attemptKey)) {
      voiceAsyncDiagnostics.voiceJobDuplicateSuppressed++;
      voiceAsyncDiagnostics.lastAttemptKey = attemptKey;
      voiceAsyncDiagnostics.lastState = "DUPLICATE_SUPPRESSED";
      return { status: "DUPLICATE_SUPPRESSED", attempt_key: attemptKey, message_id: id };
    }

    const queuedAtMs = now();
    const queuedAt = new Date(queuedAtMs).toISOString();
    mergeMessageContentJson(id, {
      voice_job: {
        attempt_key: attemptKey,
        state: "queued",
        queued_at: queuedAt,
        style: voiceStyle ?? style,
        ...(emotion ? { emotion } : {})
      },
      ...(voicePlan && typeof voicePlan === "object" ? { voice_plan: voicePlan } : {})
    });

    voiceAsyncDiagnostics.voiceEligibleCount++;
    voiceAsyncDiagnostics.voiceJobQueued++;
    voiceAsyncDiagnostics.textBeforeVoiceReadyCount++;
    voiceAsyncDiagnostics.lastAttemptKey = attemptKey;
    voiceAsyncDiagnostics.lastState = "queued";

    this.inFlight.add(attemptKey);
    this.queue.push({
      messageId: id,
      sessionId,
      text: String(text ?? row.content_text ?? ""),
      style: voiceStyle ?? style,
      voicePlan,
      attemptKey,
      queuedAtMs,
      signal,
      source
    });
    this.pump();
    return { status: "QUEUED", attempt_key: attemptKey, message_id: id };
  }

  cancel(messageId, reason = "cancelled") {
    const attemptKey = voiceAttemptKey(messageId);
    const idx = this.queue.findIndex(j => j.attemptKey === attemptKey);
    if (idx >= 0) {
      this.queue.splice(idx, 1);
      this.inFlight.delete(attemptKey);
      mergeMessageContentJson(Number(messageId), {
        voice_job: { attempt_key: attemptKey, state: reason === "stale" ? "stale" : "cancelled", error: reason }
      });
      voiceAsyncDiagnostics.voiceJobCancelled++;
      if (reason === "stale") voiceAsyncDiagnostics.voiceJobStale++;
      return true;
    }
    return false;
  }

  pump() {
    if (this.running) return;
    this.running = true;
    void (async () => {
      try {
        while (this.queue.length) {
          const job = this.queue.shift();
          await this.runJob(job);
        }
      } finally {
        this.running = false;
      }
    })();
  }

  async runJob(job) {
    const startedAtMs = this.now();
    const { messageId, sessionId, text, style, attemptKey, queuedAtMs, signal } = job;
    try {
      const row = getMessageById(messageId);
      if (!row) {
        this.finish(job, "failed", { error: "message_missing" });
        voiceAsyncDiagnostics.partialDurable++;
        return;
      }
      const content = getMessageContentObject(messageId) ?? {};
      if (content.voice_asset?.voice_asset_id && (content.voice_asset.state ?? "ready") === "ready") {
        voiceAsyncDiagnostics.voiceJobDuplicateSuppressed++;
        this.completed.add(attemptKey);
        this.inFlight.delete(attemptKey);
        mergeMessageContentJson(messageId, {
          voice_job: { attempt_key: attemptKey, state: "ready" }
        });
        return;
      }

      mergeMessageContentJson(messageId, {
        voice_job: { attempt_key: attemptKey, state: "synthesizing", started_at: new Date(startedAtMs).toISOString() }
      });
      voiceAsyncDiagnostics.voiceJobStarted++;
      latencyPush(voiceAsyncDiagnostics.ttsQueueWaitMs, startedAtMs - queuedAtMs);

      if (signal?.aborted) {
        this.finish(job, "cancelled", { error: "aborted" });
        return;
      }

      const synthStarted = this.now();
      const result = await this.synthesize({ text, style, sessionId, signal, messageId, attemptKey });
      const synthEnded = this.now();
      latencyPush(voiceAsyncDiagnostics.ttsSynthesisLatencyMs, synthEnded - synthStarted);

      if (signal?.aborted) {
        this.finish(job, "cancelled", { error: "aborted_after_synthesis" });
        return;
      }

      const audio = result?.audioBuffer ?? result?.audio ?? null;
      let voiceAsset = result?.voiceAsset ?? null;
      if (!voiceAsset) {
        if (!audio || !Buffer.isBuffer(audio)) throw Object.assign(new Error("tts produced no audio"), { code: "TTS_NO_AUDIO" });
        const duration = result?.duration ?? wavDurationSeconds(audio);
        const entry = saveVoiceMedia({ buffer: audio, duration, sessionId });
        attachMediaToMessage(entry.id, messageId);
        voiceAsset = publicVoiceAsset(entry);
      } else if (voiceAsset.voice_asset_id) {
        attachMediaToMessage(voiceAsset.voice_asset_id, messageId);
      }

      const readyAtMs = this.now();
      const shouldAutoplay = shouldAutoplayVoice(sessionId, messageId);
      if (!shouldAutoplay) voiceAsyncDiagnostics.staleVoiceAutoplaySuppressed++;

      mergeMessageContentJson(messageId, {
        voice_asset: voiceAsset,
        voice_job: {
          attempt_key: attemptKey,
          state: "ready",
          ready_at: new Date(readyAtMs).toISOString(),
          error: null
        }
      });

      this.completed.add(attemptKey);
      this.inFlight.delete(attemptKey);
      voiceAsyncDiagnostics.voiceJobReady++;
      latencyPush(voiceAsyncDiagnostics.voiceReadyLatencyMs, readyAtMs - queuedAtMs);
      voiceAsyncDiagnostics.lastState = "ready";

      const payload = {
        message_id: messageId,
        session_id: sessionId,
        attempt_key: attemptKey,
        voice_asset: voiceAsset,
        voice_style: style,
        voice_plan: job.voicePlan ?? null,
        should_autoplay: shouldAutoplay,
        text_durable_at: queuedAtMs,
        tts_started_at: synthStarted,
        tts_ready_at: readyAtMs
      };
      publishEvent("voice.ready", payload, { sessionId });
      if (typeof this.onVoiceReady === "function") {
        try { await this.onVoiceReady(payload); } catch {}
      }
    } catch (error) {
      const aborted = error?.name === "AbortError";
      this.finish(job, aborted ? "cancelled" : "failed", {
        error: String(error?.message ?? error).slice(0, 160)
      });
    }
  }

  finish(job, state, patch = {}) {
    this.completed.add(job.attemptKey);
    this.inFlight.delete(job.attemptKey);
    mergeMessageContentJson(job.messageId, {
      voice_job: {
        attempt_key: job.attemptKey,
        state,
        ...(patch.error ? { error: patch.error } : {})
      }
    });
    if (state === "failed") voiceAsyncDiagnostics.voiceJobFailed++;
    else if (state === "cancelled") voiceAsyncDiagnostics.voiceJobCancelled++;
    else if (state === "stale") voiceAsyncDiagnostics.voiceJobStale++;
    voiceAsyncDiagnostics.lastState = state;
  }

  /**
   * Restart recovery:
   * - ready asset already durable → no synth (ALREADY_READY / reconnect)
   * - queued/synthesizing without asset → re-queue once
   */
  recoverPending() {
    const rows = listPendingVoiceJobMessages(50);
    let recovered = 0, already = 0;
    for (const row of rows) {
      let content = {};
      try { content = JSON.parse(row.content_json ?? "{}") ?? {}; } catch {}
      const id = Number(row.id);
      if (content.voice_asset?.voice_asset_id) {
        mergeMessageContentJson(id, { voice_job: { state: "ready" } });
        voiceAsyncDiagnostics.voiceJobDuplicateSuppressed++;
        already++;
        continue;
      }
      const attemptKey = content.voice_job?.attempt_key ?? voiceAttemptKey(id);
      if (this.inFlight.has(attemptKey) || this.completed.has(attemptKey)) {
        voiceAsyncDiagnostics.voiceJobDuplicateSuppressed++;
        continue;
      }
      const enqueued = this.enqueue({
        messageId: id,
        sessionId: row.session_id,
        text: content.text ?? row.content_text ?? "",
        style: content.voice_job?.style ?? content.voice_plan?.voice_style ?? "neutral",
        voicePlan: content.voice_plan ?? null
      });
      if (enqueued.status === "QUEUED") recovered++;
    }
    return { recovered, already_ready: already };
  }

  waitForIdle(timeoutMs = 30000) {
    return new Promise((resolve) => {
      const started = Date.now();
      const check = () => {
        if (!this.running && this.queue.length === 0) { resolve(true); return; }
        if (Date.now() - started > timeoutMs) { resolve(false); return; }
        setTimeout(check, 15);
      };
      check();
    });
  }
}

export const defaultVoiceAsyncQueue = new VoiceAsyncQueue();

export function enqueueAssistantVoice(payload) {
  return defaultVoiceAsyncQueue.enqueue(payload);
}

export function recoverPendingVoiceJobs(queue = defaultVoiceAsyncQueue) {
  return queue.recoverPending();
}
