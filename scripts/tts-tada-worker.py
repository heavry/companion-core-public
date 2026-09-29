#!/usr/bin/env python3
"""TADA-1B zero-shot worker for Companion TTS provider. Writes WAV only."""
from __future__ import annotations
import sys
import os
from pathlib import Path

TEXT = sys.argv[1] if len(sys.argv) > 1 else "宝宝，我回来啦。"
OUT = sys.argv[2] if len(sys.argv) > 2 else "/tmp/tada-out.wav"
ROOT = Path(os.environ.get("COMPANION_TADA_ROOT", str(Path.home() / "TADA")))
REF = str(ROOT / "00_clone_ref.wav")
REF_TXT = (ROOT / "00_clone_ref.txt").read_text(encoding="utf-8").strip()

from transformers import AutoTokenizer
from tada.modules import aligner as aligner_mod
from tada.modules import tada as tada_mod
from tada.modules.encoder import Encoder
from tada.modules.tada import TadaForCausalLM, InferenceOptions

_orig = AutoTokenizer.from_pretrained

def _tok(name, *a, **k):
    if "Llama-3.2-1B" in str(name) and not str(name).startswith("unsloth/"):
        name = "unsloth/Llama-3.2-1B"
    return _orig(name, *a, **k)

AutoTokenizer.from_pretrained = _tok
aligner_mod.AutoTokenizer.from_pretrained = _tok
tada_mod.AutoTokenizer.from_pretrained = _tok

import torch
import numpy as np
import soundfile as sf
import torchaudio

encoder = Encoder.from_pretrained("HumeAI/tada-codec", subfolder="encoder", language="ch")
model = TadaForCausalLM.from_pretrained("HumeAI/tada-1b", torch_dtype=torch.float32)
if hasattr(model, "lm_head"):
    model.lm_head.to("cpu")
model.eval()
wav_np, sr = sf.read(REF, dtype="float32")
if wav_np.ndim > 1:
    wav_np = wav_np.mean(axis=1)
audio = torch.from_numpy(np.asarray(wav_np, dtype=np.float32)).unsqueeze(0)
prompt = encoder(audio, text=[REF_TXT], sample_rate=sr)
del encoder
with torch.inference_mode():
    output = model.generate(
        prompt=prompt,
        text=TEXT,
        system_prompt="Natural friendly Chinese speech.",
        use_text_in_prompt=True,
        verbose=False,
        inference_options=InferenceOptions(num_flow_matching_steps=4, num_acoustic_candidates=1),
    )
waveform = output.audio if hasattr(output, "audio") else output
if hasattr(waveform, "detach"):
    waveform = waveform.detach().cpu().numpy()
waveform = np.asarray(waveform, dtype=np.float32)
if waveform.ndim == 2:
    waveform = waveform[0] if waveform.shape[0] <= 8 else waveform[:, 0]
out_sr = int(getattr(output, "sample_rate", 24000))
Path(OUT).parent.mkdir(parents=True, exist_ok=True)
torchaudio.save(OUT, torch.from_numpy(waveform).unsqueeze(0), out_sr)
print(OUT)
