export const WAKE_PHRASE = "林小糖";
export const WAKE_KEYWORDS_LINE = "l ín x iǎo t áng @林小糖";
export const WAKE_STATES = Object.freeze(["disabled", "starting", "listening", "detected", "handoff", "suspended", "error"]);
export const PRE_ROLL_SECONDS = 0.9;
export const ONE_SHOT_TIMEOUT_SECONDS = 5.5;
export const TTS_HOLDOFF_SECONDS = 0.45;
export const PERSIST_AMBIENT_AUDIO = false;
export const CREATES_ATTENTION_ON_WAKE = false;
export const DEFAULT_ENABLED = false;
export const PRODUCT_QUALIFIED = false;

export function stripWakePhrase(text = "") {
  return String(text)
    .replace(/^\s*林小糖[，,。.\s]*/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function compactWakeText(text = "") {
  return stripWakePhrase(text).replace(/[\s，,。.!！？?、]/gu, "");
}

export function classifyWakeCommand(text = "") {
  const compact = compactWakeText(text);
  if (!compact) return "empty";
  if (/^(进入(语音)?通话|开始语音通话|跟我聊会儿|跟我聊会)$/.test(compact)) return "start_call";
  if (/^(先别听了|关闭唤醒|暂停唤醒词)$/.test(compact)) return "disable_wake";
  if (/^(算了|没事了|取消)$/.test(compact)) return "cancel";
  return "utterance";
}

export function persistUserText(command, stripped = "") {
  if (command === "utterance") {
    const value = String(stripped ?? "").trim();
    return value || null;
  }
  return null;
}

export function shouldListen({
  enabled = false,
  locked = false,
  sleeping = false,
  voiceCallActive = false,
  assistantAudioPlaying = false,
  suspendWhileLocked = true
} = {}) {
  if (!enabled) return { listen: false, state: "disabled" };
  if (sleeping) return { listen: false, state: "suspended", reason: "sleep" };
  if (locked && suspendWhileLocked) return { listen: false, state: "suspended", reason: "lock" };
  if (voiceCallActive) return { listen: false, state: "suspended", reason: "voice_call" };
  return { listen: true, state: "listening", playback_gate: Boolean(assistantAudioPlaying) };
}

export function shouldResumeMicrophone(event = "", { enabled = false, locked = false, sleeping = false } = {}) {
  if (!enabled) return false;
  if (event === "launch" || event === "sleep" || event === "wake" || event === "lock") return false;
  if (event === "unlock") return !locked && !sleeping;
  if (event === "end_call" || event === "playback_end" || event === "setting_on") return !locked && !sleeping;
  return false;
}

export function gateDetections(detections = [], { assistantAudioPlaying = false, holdoffUntil = 0, now = Date.now() } = {}) {
  if (assistantAudioPlaying) return [];
  if (now < holdoffUntil) return [];
  return Array.isArray(detections) ? detections.filter(item => item && (item.keyword === WAKE_PHRASE || item.keyword === "林小糖")) : [];
}

export function sensitivityThreshold(level = "normal") {
  if (level === "low") return 0.35;
  if (level === "high") return 0.18;
  return 0.25;
}

export function overlayTitle(phase = "listening") {
  if (phase === "detected" || phase === "capturing") return "正在听…";
  if (phase === "answering" || phase === "handoff") return "正在回答";
  if (phase === "listening") return "等待唤醒";
  return "林小糖";
}

export function resolveWakeUtterance(text = "") {
  const raw = String(text ?? "").trim();
  const stripped = stripWakePhrase(raw);
  const command = classifyWakeCommand(raw);
  return {
    command,
    raw,
    stripped,
    persist_user_text: persistUserText(command, stripped),
    persist_wake_phrase: false,
    write_memory_raw: false,
    create_attention: CREATES_ATTENTION_ON_WAKE,
    persist_audio: PERSIST_AMBIENT_AUDIO
  };
}

export function emptyWakeMetrics() {
  return {
    version: 1,
    listening_seconds: 0,
    wake_detections: 0,
    one_shot_turns: 0,
    timeouts: 0,
    cancels: 0,
    false_wake_dismiss: 0,
    call_starts: 0,
    disable_commands: 0,
    cost_usd: 0,
    input_tokens: 0,
    output_tokens: 0
  };
}
