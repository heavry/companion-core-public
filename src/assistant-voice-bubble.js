import fs from "node:fs";
import { saveVoiceMedia } from "./media.js";
import { wavDurationSeconds, publicVoiceAsset } from "./voice-message-delivery.js";
import { synthesizeWithSelectedProvider, selectedTtsProviderId } from "./tts-providers.js";

/** Per-bubble assistant TTS using selected TTS provider (default GPT-SoVITS). */
export async function synthesizeAssistantBubble({ text, style = "neutral", sessionId = "", signal = null } = {}) {
  const result = await synthesizeWithSelectedProvider({ text, style, sessionId, signal });
  const audio = Buffer.isBuffer(result.audio) ? result.audio : fs.readFileSync(result.audioPath ?? "");
  const duration = wavDurationSeconds(audio);
  const entry = saveVoiceMedia({ buffer: audio, duration, sessionId });
  return {
    voiceAsset: publicVoiceAsset(entry),
    durationMs: Math.round(duration * 1000),
    style: result.style ?? style,
    bytes: audio.length,
    provider: result.provider ?? selectedTtsProviderId(),
  };
}

