import crypto from "node:crypto";

export const uuid = () => crypto.randomUUID();
export const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

export function stableJson(value) {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
}

export function messageText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object") {
        if (typeof part.text === "string") return part.text;
        if (part.type === "text" && typeof part.content === "string") return part.content;
      }
      return "";
    }).filter(Boolean).join("\n");
  }
  if (content == null) return "";
  try { return JSON.stringify(content); } catch { return String(content); }
}

export function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== "user") continue;
    const t = messageText(messages[i].content).trim();
    if (t) return t.slice(0, 4000);
  }
  return "";
}

export function incomingTail(messages) {
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") { lastAssistant = i; break; }
  }
  const tail = lastAssistant >= 0 ? messages.slice(lastAssistant + 1) : messages.slice(-1);
  return tail.filter(m => m.role !== "system" && m.role !== "developer");
}

export function normalizeMemoryText(text) {
  return text.trim().replace(/\s+/g, " ").replace(/[，。！？；：、,.!?;:]/g, "").toLowerCase();
}

export function compactText(s) {
  return String(s ?? "").toLowerCase().replace(/\s+/g, "").replace(/[，。！？；：、,.!?;:'"`()\[\]{}<>]/g, "");
}

export function ngrams(s, n = 2) {
  const x = compactText(s);
  const out = [];
  for (let i = 0; i <= x.length - n; i++) out.push(x.slice(i, i + n));
  return [...new Set(out)];
}

export function textSimilarity(a, b) {
  const A = new Set(ngrams(a, 2)), B = new Set(ngrams(b, 2));
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const x of A) if (B.has(x)) hit++;
  return hit / Math.max(1, Math.min(A.size, B.size));
}

export function messageSignature(m) {
  return sha256(stableJson({
    role: m?.role ?? "",
    content: m?.content ?? null,
    tool_calls: m?.tool_calls ?? null,
    tool_call_id: m?.tool_call_id ?? null,
    name: m?.name ?? null
  }));
}

export function mergeMessageHistories(stored, client) {
  if (!stored?.length) return client;
  if (!client?.length) return stored;

  const leading = [];
  let firstConversation = 0;
  while (firstConversation < client.length && ["system", "developer"].includes(client[firstConversation]?.role)) {
    leading.push(client[firstConversation]);
    firstConversation++;
  }
  const convo = client.slice(firstConversation);
  if (!convo.length) return [...leading, ...stored];

  const s = stored.map(messageSignature);
  const c = convo.map(messageSignature);
  let overlap = 0;
  for (let k = Math.min(s.length, c.length); k >= 1; k--) {
    let ok = true;
    for (let i = 0; i < k; i++) {
      if (s[s.length - k + i] !== c[i]) { ok = false; break; }
    }
    if (ok) { overlap = k; break; }
  }
  return [...leading, ...stored.slice(0, stored.length - overlap), ...convo];
}

export function parseJsonLoose(text) {
  const fenced = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try { return JSON.parse(fenced); } catch {}
  const a = fenced.indexOf("{"), b = fenced.lastIndexOf("}");
  if (a >= 0 && b > a) return JSON.parse(fenced.slice(a, b + 1));
  throw new Error("模型输出不是合法 JSON");
}

export async function readBody(req, maxBytes = 25 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const err = new Error("request body too large");
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJsonBody(req, maxBytes = 25 * 1024 * 1024) {
  const raw = (await readBody(req, maxBytes)).toString("utf8");
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch {
    const err = new Error("invalid JSON body");
    err.statusCode = 400;
    throw err;
  }
}

export function json(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
}

export function clamp01(n) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0.5;
}

export function cleanKey(value, fallback, max = 200) {
  const s = typeof value === "string" ? value.trim().replace(/[\u0000-\u001f\u007f]/g, "") : "";
  return (s || fallback).slice(0, max);
}

export function isLoopback(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
