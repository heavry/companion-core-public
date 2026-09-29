#!/usr/bin/env node
/**
 * A/B: synthesize 5 fixed phrases on every confirmed 林小糖 TTS provider.
 * Saves raw WAV under diagnostics/tts-provider-ab/<provider>/.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const KEY = process.env.COMPANION_API_KEY ?? "09417c4ade38fc368282bfa095ad0a7327fad36c8acb636defafda978ce2a1c5";
const BASE = process.env.CANDIDATE_BASE ?? "http://127.0.0.1:8770";
const OUT_ROOT = path.resolve("diagnostics/tts-provider-ab");
const PHRASES = [
  "宝宝，我回来啦。",
  "我知道了，你先忙吧。",
  "你今天怎么样？",
  "嗯，我想一下。",
  "行，那你先去，我等你回来。",
];

async function api(pathname, init = {}) {
  const res = await fetch(BASE + pathname, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}`, ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function listProviders() {
  const r = await api("/admin/tts-providers");
  if (r.status !== 200) throw new Error(`list providers HTTP ${r.status}`);
  return r.body;
}

async function select(id) {
  const r = await api("/admin/tts-providers/select", { method: "POST", body: JSON.stringify({ id }) });
  if (r.status !== 200) throw new Error(`select ${id} HTTP ${r.status}`);
  return r.body;
}

async function synth(text) {
  const t0 = Date.now();
  const r = await api("/admin/tts-providers/synthesize", {
    method: "POST",
    body: JSON.stringify({ text, session_id: `ab-${Date.now()}` }),
  });
  const elapsed = Date.now() - t0;
  return { ...r, elapsed };
}

// After synthesize, copy the newest voice media if possible — provider returns meta not path.
// Prefer provider meta.outFile / voice media dir scan.
function newestWavSince(dir, sinceMs) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".wav"))
    .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .filter(x => x.t >= sinceMs - 2000)
    .sort((a, b) => b.t - a.t);
  return files[0] ? path.join(dir, files[0].f) : null;
}

const mediaDir = path.join(os.homedir(), "Library/Application Support/CompanionCore-candidate", "media");
const cosyOut = path.join(os.homedir(), "Desktop/CosyVoice-test"); // not used; provider writes under voiceDir

const catalog = await listProviders();
console.log("selected", catalog.selected);
console.log("providers", catalog.providers.map(p => ({ id: p.id, available: p.available, name: p.name })));

const report = [];
for (const p of catalog.providers.filter(x => x.available)) {
  console.log(`\n=== ${p.id} ===`);
  try { await select(p.id); } catch (e) { console.log("select skip", e.message); continue; }
  const dir = path.join(OUT_ROOT, p.id);
  fs.mkdirSync(dir, { recursive: true });
  for (const phrase of PHRASES) {
    const safe = phrase.replace(/[？?，。！!、\s]+/g, "_");
    const before = Date.now();
    const r = await synth(phrase);
    const row = { provider: p.id, phrase, http: r.status, elapsed_ms: r.elapsed, ...r.body };
    // try locate wav
    const providerOut = r.body?.meta?.outFile;
    let src = providerOut && fs.existsSync(providerOut) ? providerOut : null;
    if (!src) src = newestWavSince(path.join(mediaDir, "voice"), before) || newestWavSince(mediaDir, before);
    const dest = path.join(dir, `${safe}.wav`);
    if (src) fs.copyFileSync(src, dest);
    row.saved = src ? dest : null;
    report.push(row);
    console.log(JSON.stringify({ phrase, http: r.status, elapsed: r.elapsed, duration_ms: r.body?.duration_ms, provider: r.body?.provider, saved: row.saved }));
  }
}

fs.writeFileSync(path.join(OUT_ROOT, "report.json"), JSON.stringify(report, null, 2));
console.log("\nreport", path.join(OUT_ROOT, "report.json"));
