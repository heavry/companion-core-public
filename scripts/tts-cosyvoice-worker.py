#!/usr/bin/env python3
"""CosyVoice3 zero-shot worker for Companion TTS provider. Writes WAV only."""
from __future__ import annotations
import sys
import os
from pathlib import Path

TEXT = sys.argv[1] if len(sys.argv) > 1 else "宝宝，我回来啦。"
OUT = sys.argv[2] if len(sys.argv) > 2 else "/tmp/cosy-out.wav"
COSY = Path(os.environ.get("COMPANION_COSYVOICE_ROOT", str(Path.home() / "CosyVoice")))
REF = os.environ.get("COMPANION_COSYVOICE_REFERENCE_AUDIO", str(Path.home() / "CompanionVoice" / "reference.wav"))
PROMPT = "回来了，你还知道回来？别碰我！我让你别碰我！"
INSTRUCT = "You are a helpful assistant. 请用自然、亲昵的中文口语说话。<|endofprompt|>"
sys.path[:0] = [str(COSY), str(COSY / "third_party" / "Matcha-TTS")]
from cosyvoice.cli.cosyvoice import CosyVoice3
import torchaudio

model = CosyVoice3(model_dir=str(COSY / "pretrained_models" / "Fun-CosyVoice3-0.5B"))
chunks = list(model.inference_instruct2(
    tts_text=TEXT,
    instruct_text=INSTRUCT,
    prompt_wav=REF,
    stream=False,
    text_frontend=True,
))
if not chunks:
    raise SystemExit("no speech")
speech = chunks[0]["tts_speech"]
Path(OUT).parent.mkdir(parents=True, exist_ok=True)
torchaudio.save(OUT, speech.cpu(), model.sample_rate)
print(OUT)
