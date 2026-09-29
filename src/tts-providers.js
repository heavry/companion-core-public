import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const localHome = os.homedir();
import { spawn } from "node:child_process";
import { config } from "./config.js";
import { localGPTSoVITSService } from "./local-gpt-sovits-service.js";
import { wavDurationSeconds } from "./voice-message-delivery.js";

// TTS Provider registry: only engines proven to synthesize 鱼筱/林小糖.
// Default remains gpt_sovits. No auto-switch on failure.

const PROVIDER_ORDER = ["gpt_sovits", "voicebox", "cosyvoice", "tada", "fish_s2_pro", "voxcpmane"];

const STATE_FILE = path.resolve(
  process.env.COMPANION_TTS_PROVIDER_STATE ||
  path.join(process.env.HOME ?? "", "Library/Application Support/CompanionCore-candidate", "tts-provider.json")
);

function readJson(file, fallback){
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}
function writeJson(file, value){
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function httpOk(url, timeoutMs=1500){
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    .then(r => r.ok)
    .catch(() => false);
}

function runWithPython(python, script, args, { timeoutMs=180000, env={} }={}){
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`tts worker timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { err += d; });
    child.on("error", e => { clearTimeout(timer); reject(e); });
    child.on("close", code => {
      clearTimeout(timer);
      if(code !== 0) reject(new Error(`tts worker exit ${code}: ${err.slice(-500)}`));
      else resolve({ stdout: out, stderr: err });
    });
  });
}

export function loadTtsProviderState(){
  const s = readJson(STATE_FILE, {});
  return {
    selected: typeof s.selected === "string" && s.selected ? s.selected : "gpt_sovits",
  };
}

export function saveTtsProviderState(patch){
  const next = { ...loadTtsProviderState(), ...patch };
  writeJson(STATE_FILE, next);
  return next;
}

export function selectedTtsProviderId(){
  return loadTtsProviderState().selected;
}

export function setSelectedTtsProvider(id){
  if(!PROVIDER_ORDER.includes(id)){
    throw Object.assign(new Error(`unknown tts provider: ${id}`), { statusCode: 400 });
  }
  saveTtsProviderState({ selected: id });
  return loadTtsProviderState();
}

// Voicebox GUI 使用动态端口（例如 17493），不一定等于旧默认 8791。
const VOICEBOX_PORT_CACHE_MS = 15000;
let voiceboxPortCache = { port: null, at: 0 };

function ttsLog(fields){
  try{
    const line = Object.entries(fields)
      .filter(([,v]) => v !== undefined && v !== null && v !== "")
      .map(([k,v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
      .join(" ");
    console.log(`[tts] ${line}`);
  }catch{}
}

/** VoxCPMANE HTTP worker on Apple Silicon (CoreML/ANE). Uses server-side voice cache. */
function voxcpmaneBaseUrl(){
  return (process.env.COMPANION_VOXCPMANE_URL || "http://127.0.0.1:7862").replace(/\/+$/, "");
}
function voxcpmaneVoiceId(){
  return process.env.COMPANION_VOXCPMANE_VOICE || "linxt30";
}
function voxcpmaneVoiceCachePaths(){
  const custom = path.join(process.env.HOME ?? "", ".cache/ane_tts");
  const voice = voxcpmaneVoiceId();
  return {
    customDir: custom,
    embed: path.join(custom, `${voice}.embed.npy`),
    prefix: path.join(custom, `${voice}.lm_prefix.npz`),
  };
}

async function probeVoxcpmaneHealth(baseUrl, timeoutMs = 1200){
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, status: res.status, body: null };
    const body = await res.json().catch(() => null);
    return { ok: body?.status === "healthy" || res.ok, status: res.status, body };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

async function describeVoxcpmaneStatus(){
  const baseUrl = voxcpmaneBaseUrl();
  const voice = voxcpmaneVoiceId();
  const cache = voxcpmaneVoiceCachePaths();
  const health = await probeVoxcpmaneHealth(baseUrl);
  const hasCache = fs.existsSync(cache.embed) || fs.existsSync(cache.prefix);
  // available = endpoint + reference profile exist enough to try; stopped vs running from /health
  const available = Boolean(hasCache);
  const running = Boolean(health.ok);
  let state = "unavailable";
  let detail = `endpoint ${baseUrl}`;
  if (!available) {
    state = "unavailable";
    detail = `voice cache missing under ${cache.customDir} (voice=${voice})`;
  } else if (running) {
    state = "ready";
    detail = `${baseUrl} running · voice=${voice}`;
  } else {
    state = "stopped";
    detail = `${baseUrl} stopped/unhealthy · voice=${voice} cached`;
  }
  return {
    baseUrl,
    voice,
    available,
    running,
    state,
    detail,
    healthStatus: health.status,
    healthBody: health.body,
    cache,
  };
}

async function probeVoiceboxPort(port, timeoutMs = 800){
  if (!Number.isFinite(port) || port <= 0) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Resolve actual Voicebox server port: env → cache → known ports → process cmdline. */
export async function resolveVoiceboxPort({ force = false, timeoutMs = 800 } = {}) {
  const now = Date.now();
  if (!force && voiceboxPortCache.port && now - voiceboxPortCache.at < VOICEBOX_PORT_CACHE_MS) {
    return voiceboxPortCache.port;
  }
  const envPort = Number(process.env.COMPANION_VOICEBOX_PORT || 0);
  const candidates = [envPort, 8791, 17493, 17494, 8080, 8760]
    .filter((p, i, a) => Number.isFinite(p) && p > 0 && a.indexOf(p) === i);
  for (const port of candidates) {
    if (await probeVoiceboxPort(port, timeoutMs)) {
      voiceboxPortCache = { port, at: now };
      return port;
    }
  }
  // Discover from running voicebox-server --port N
  try {
    const { execSync } = await import("node:child_process");
    const out = execSync("ps -axww -o args=", { encoding: "utf8", timeout: 1500 });
    for (const line of out.split("\n")) {
      if (!/voicebox-server/i.test(line)) continue;
      const m = line.match(/--port\s+(\d+)/);
      if (!m) continue;
      const port = Number(m[1]);
      if (await probeVoiceboxPort(port, timeoutMs)) {
        voiceboxPortCache = { port, at: now };
        return port;
      }
    }
  } catch {}
  voiceboxPortCache = { port: null, at: now };
  return null;
}

export async function listTtsProviders(){
  const selected = selectedTtsProviderId();
  const gsv = localGPTSoVITSService.publicStatus();
  const voiceboxPort = await resolveVoiceboxPort();
  const voiceboxUp = voiceboxPort != null;
  const cosyPython = process.env.COMPANION_COSYVOICE_PYTHON ||
    path.join(localHome, "CosyVoice", ".venv", "bin", "python");
  const tadaPython = process.env.COMPANION_TADA_PYTHON ||
    path.join(localHome, "TADA", ".venv", "bin", "python");
  const vox = await describeVoxcpmaneStatus();
  // available ≠ currently loaded. GPT api down but files/env OK → available+unloaded.
  const gptConfigured = Boolean(gsv.configured);
  const gptEnabled = Boolean(gsv.enabled);
  const gptLoaded = Boolean(gsv.ready);
  const providers = [
    {
      id: "gpt_sovits",
      name: "GPT-SoVITS · 林小糖",
      available: gptConfigured && gptEnabled,
      loaded: gptLoaded,
      state: gsv.state ?? "stopped",
      detail: !gptConfigured
        ? "runtime/model missing"
        : !gptEnabled
          ? "disabled in voice settings"
          : gptLoaded
            ? `loaded :${gsv.endpoint?.split(":")?.[1] ?? "9880"}`
            : "available / unloaded (lazy start on next voice)",
      supportsStyle: true,
      kind: "trained",
    },
    {
      id: "voicebox",
      name: "Voicebox · 鱼筱 Clone",
      available: voiceboxUp,
      loaded: voiceboxUp,
      state: voiceboxUp ? "ready" : "stopped",
      detail: voiceboxUp ? `http://127.0.0.1:${voiceboxPort}` : "server not running (checked 8791/17493/process)",
      supportsStyle: false,
      kind: "reference_clone",
      profileId: process.env.COMPANION_VOICEBOX_PROFILE_ID || "0763cc16-4523-4b65-90d0-823a0dfd8e5f",
    },
    {
      id: "cosyvoice",
      name: "CosyVoice3 · 鱼筱 Clone",
      available: fs.existsSync(cosyPython),
      loaded: false,
      state: "worker",
      detail: fs.existsSync(cosyPython) ? cosyPython : "python missing",
      supportsStyle: false,
      kind: "reference_clone",
    },
    {
      id: "tada",
      name: "TADA-1B · 鱼筱 Clone",
      available: fs.existsSync(tadaPython),
      loaded: false,
      state: "worker",
      detail: fs.existsSync(tadaPython) ? tadaPython : "python missing",
      supportsStyle: false,
      kind: "reference_clone",
    },
    {
      id: "fish_s2_pro",
      name: "Fish S2 Pro · 鱼筱 Clone",
      available: false,
      loaded: false,
      state: "unavailable",
      detail: "mlx_speech unavailable (model cache present, not runnable)",
      supportsStyle: false,
      kind: "reference_clone",
      assets: {
        modelCache: null,
        referenceAudio: null,
      },
    },
    {
      id: "voxcpmane",
      name: "VoxCPMANE · 林小糖 Clone",
      available: vox.available,
      loaded: vox.running,
      state: vox.state,
      detail: vox.detail,
      supportsStyle: false,
      kind: "reference_clone",
      profileId: vox.voice,
      assets: {
        endpoint: vox.baseUrl,
        voiceCacheDir: vox.cache.customDir,
      },
    },
  ];
  return { selected, providers };
}

async function synthesizeGptSovits({ text, style, sessionId, signal }){
  ttsLog({ selected_provider: selectedTtsProviderId(), resolved_provider: "gpt_sovits", worker: "local-gpt-sovits", session: sessionId });
  const result = await localGPTSoVITSService.synthesize({ text, sessionId, signal, style });
  const file = localGPTSoVITSService.audioPath(result.id);
  const audio = fs.readFileSync(file);
  ttsLog({ resolved_provider: "gpt_sovits", output: file, bytes: audio.length, ok: true });
  return {
    id: result.id,
    provider: "gpt_sovits",
    style: result.style,
    bytes: audio.length,
    durationMs: Math.round(wavDurationSeconds(audio) * 1000),
    contentType: "audio/wav",
    audio,
    meta: { engine: "gpt_sovits", style: result.style },
  };
}

async function synthesizeVoicebox({ text, sessionId, signal }){
  const port = await resolveVoiceboxPort({ force: true });
  if(!port) throw Object.assign(new Error("Voicebox server not running (no healthy port)"), { code: "TTS_UNAVAILABLE" });
  const profileId = process.env.COMPANION_VOICEBOX_PROFILE_ID || "0763cc16-4523-4b65-90d0-823a0dfd8e5f";
  const baseUrl = `http://127.0.0.1:${port}`;
  ttsLog({ selected_provider: selectedTtsProviderId(), resolved_provider: "voicebox", worker: `http:${port}`, session: sessionId, profile: profileId });
  const genRes = await fetch(`${baseUrl}/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profile_id: profileId, text, language: "zh", engine: "qwen", model_size: "1.7B" }),
    signal: signal ?? AbortSignal.timeout(120000),
  });
  if(!genRes.ok) throw new Error(`Voicebox generate HTTP ${genRes.status}`);
  const gen = await genRes.json();
  const id = gen.id;
  const deadline = Date.now() + 90000;
  let status = gen;
  while(Date.now() < deadline){
    if(signal?.aborted) throw Object.assign(new Error("cancelled"), { name: "AbortError" });
    const h = await fetch(`${baseUrl}/history/${id}`, { signal: AbortSignal.timeout(5000) }).then(r => r.json()).catch(() => null);
    if(h?.status === "completed" || h?.status === "failed"){ status = h; break; }
    await new Promise(r => setTimeout(r, 500));
  }
  if(status?.status !== "completed" || !status?.audio_path){
    throw new Error(`Voicebox generation not ready: ${status?.status ?? "unknown"} ${status?.error ?? ""}`);
  }
  const rel = String(status.audio_path).replace(/^\/+/, "");
  const abs = path.isAbsolute(rel) ? rel : path.join(process.env.HOME ?? "", "Library/Application Support/sh.voicebox.app", rel);
  const audio = fs.readFileSync(abs);
  ttsLog({ resolved_provider: "voicebox", output: abs, bytes: audio.length, generation_status: status.status, ok: true });
  return {
    id,
    provider: "voicebox",
    style: "neutral",
    bytes: audio.length,
    durationMs: Math.round(Number(status.duration || wavDurationSeconds(audio)) * 1000),
    contentType: "audio/wav",
    audio,
    meta: { engine: status.engine ?? "qwen", profile: "鱼筱", port, generationId: id },
  };
}

async function synthesizeVoxcpmane({ text, sessionId, signal }){
  const status = await describeVoxcpmaneStatus();
  if (!status.available) {
    ttsLog({
      selected_provider: "voxcpmane",
      resolved_provider: "voxcpmane",
      worker: status.baseUrl,
      session: sessionId,
      error: "TTS_UNAVAILABLE",
    });
    throw Object.assign(
      new Error(`VoxCPMANE unavailable (${status.detail})`),
      { code: "TTS_UNAVAILABLE" }
    );
  }
  if (!status.running) {
    ttsLog({
      selected_provider: "voxcpmane",
      resolved_provider: "voxcpmane",
      worker: status.baseUrl,
      session: sessionId,
      error: "TTS_UNAVAILABLE",
      detail: "server stopped",
    });
    throw Object.assign(
      new Error(`VoxCPMANE server not running at ${status.baseUrl}`),
      { code: "TTS_UNAVAILABLE" }
    );
  }

  const worker = status.baseUrl;
  ttsLog({
    selected_provider: selectedTtsProviderId(),
    resolved_provider: "voxcpmane",
    worker,
    session: sessionId,
    profile: status.voice,
    text_preview: String(text).slice(0, 40),
  });

  const t0 = Date.now();
  const res = await fetch(`${worker}/v1/audio/speech`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "voxcpm2",
      input: String(text),
      voice: status.voice,
      voice_mode: "reference",
      response_format: "wav",
      inference_timesteps: 10,
      cfg_value: 2.0,
    }),
    signal: signal ?? AbortSignal.timeout(60000),
  });
  const durationMs = Date.now() - t0;

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    ttsLog({
      selected_provider: "voxcpmane",
      resolved_provider: "voxcpmane",
      worker,
      session: sessionId,
      duration_ms: durationMs,
      ok: false,
      http: res.status,
      error: errText.slice(0, 160),
    });
    throw Object.assign(
      new Error(`VoxCPMANE generate HTTP ${res.status}`),
      { code: "TTS_UNAVAILABLE", statusCode: res.status }
    );
  }

  const audio = Buffer.from(await res.arrayBuffer());
  if (!audio.length || audio.toString("ascii", 0, 4) !== "RIFF") {
    ttsLog({
      selected_provider: "voxcpmane",
      resolved_provider: "voxcpmane",
      worker,
      session: sessionId,
      duration_ms: durationMs,
      ok: false,
      error: "invalid_wav",
    });
    throw Object.assign(new Error("VoxCPMANE returned non-WAV payload"), { code: "TTS_UNAVAILABLE" });
  }

  const id = `voxcpmane_${sessionId || "x"}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let audioSec = 0;
  try {
    audioSec = wavDurationSeconds(audio);
  } catch {}

  ttsLog({
    selected_provider: "voxcpmane",
    resolved_provider: "voxcpmane",
    worker,
    session: sessionId,
    duration_ms: durationMs,
    audio_ms: Math.round(audioSec * 1000),
    bytes: audio.length,
    ok: true,
  });

  return {
    id,
    provider: "voxcpmane",
    style: "neutral",
    bytes: audio.length,
    durationMs: Math.round(audioSec * 1000),
    contentType: "audio/wav",
    audio,
    meta: {
      engine: "voxcpmane",
      endpoint: worker,
      voice: status.voice,
      generationWallMs: durationMs,
      sampleRate: 48000,
      channels: 1,
    },
  };
}

const COSY_SCRIPT = path.resolve("./scripts/tts-cosyvoice-worker.py");
const TADA_SCRIPT = path.resolve("./scripts/tts-tada-worker.py");

async function synthesizePythonProvider({ provider, text, sessionId, signal }){
  const worker = provider === "cosyvoice" ? COSY_SCRIPT : TADA_SCRIPT;
  const python = provider === "cosyvoice"
    ? (process.env.COMPANION_COSYVOICE_PYTHON || path.join(localHome, "CosyVoice", ".venv", "bin", "python"))
    : (process.env.COMPANION_TADA_PYTHON || path.join(localHome, "TADA", ".venv", "bin", "python"));
  const outDir = path.join(config.voiceDir, "providers", provider);
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${sessionId || "x"}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.wav`);
  const timeoutMs = provider === "tada" ? 180000 : 120000;
  ttsLog({ selected_provider: selectedTtsProviderId(), resolved_provider: provider, worker: `${python} ${worker}`, session: sessionId, out: outFile });
  await runWithPython(python, worker, [text, outFile], { timeoutMs });
  if(!fs.existsSync(outFile)) throw new Error(`${provider} produced no wav`);
  const audio = fs.readFileSync(outFile);
  ttsLog({ resolved_provider: provider, output: outFile, bytes: audio.length, ok: true });
  return {
    id: path.basename(outFile, ".wav"),
    provider,
    style: "neutral",
    bytes: audio.length,
    durationMs: Math.round(wavDurationSeconds(audio) * 1000),
    contentType: "audio/wav",
    audio,
    meta: { engine: provider, outFile },
  };
}

/**
 * Unified synthesize for the selected provider.
 * Failure throws — caller keeps existing TEXT fallback. No silent provider switch.
 */
export async function synthesizeWithSelectedProvider({ text, style="neutral", sessionId="", signal=null }={}){
  const id = selectedTtsProviderId();
  ttsLog({ selected_provider: id, session: sessionId, text_preview: String(text).slice(0, 40) });
  if(id === "gpt_sovits") return synthesizeGptSovits({ text, style, sessionId, signal });
  if(id === "voicebox") return synthesizeVoicebox({ text, sessionId, signal });
  if(id === "cosyvoice" || id === "tada") return synthesizePythonProvider({ provider: id, text, sessionId, signal });
  if(id === "voxcpmane") return synthesizeVoxcpmane({ text, sessionId, signal });
  if(id === "fish_s2_pro"){
    ttsLog({ selected_provider: id, resolved_provider: null, error: "TTS_UNAVAILABLE" });
    throw Object.assign(
      new Error("Fish S2 Pro · 鱼筱 Clone · unavailable (mlx_speech not installed)"),
      { code: "TTS_UNAVAILABLE" }
    );
  }
  ttsLog({ selected_provider: id, resolved_provider: null, error: "TTS_UNKNOWN_PROVIDER" });
  throw Object.assign(new Error(`unknown selected provider ${id}`), { code: "TTS_UNKNOWN_PROVIDER" });
}

export { PROVIDER_ORDER };
