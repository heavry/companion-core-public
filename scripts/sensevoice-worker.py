#!/usr/bin/env python3
"""Private JSON-lines SenseVoice worker. Audio is deleted after each request."""
import base64
import contextlib
import io
import json
import os
import re
import sys
import tempfile
import time

import librosa
import numpy as np
from funasr import AutoModel
from funasr.utils.postprocess_utils import rich_transcription_postprocess

LANGUAGES = {"zh", "en", "yue", "ja", "ko", "nospeech"}
EMOTIONS = {"NEUTRAL", "HAPPY", "SAD", "ANGRY", "FEARFUL", "DISGUSTED", "SURPRISED", "EMO_UNKNOWN"}
NON_EVENTS = LANGUAGES | EMOTIONS | {"withitn", "woitn", "itn", "noitn"}


def decode_result(raw_text):
    tags = re.findall(r"<\|([^|]+)\|>", raw_text)
    return {
        "transcript": rich_transcription_postprocess(raw_text).strip(),
        "language": next((x for x in tags if x in LANGUAGES), None),
        "emotion": next((x.lower() for x in tags if x in EMOTIONS), None),
        "audio_events": [x for x in tags if x not in NON_EVENTS],
        "raw_tags": tags,
    }


def prosody(path):
    y, sr = librosa.load(path, sr=16000, mono=True)
    duration = len(y) / float(sr) if sr else 0.0
    if not len(y):
        return duration, {"pitch_mean_hz": None, "pitch_range_hz": None, "energy_rms_mean": 0.0, "pause_ratio": 1.0}
    rms = librosa.feature.rms(y=y, frame_length=400, hop_length=160)[0]
    threshold = max(float(np.percentile(rms, 20)) * 2.0, 1e-4)
    voiced = rms > threshold
    pitch = librosa.yin(y, fmin=65, fmax=500, sr=sr, frame_length=1024, hop_length=160)
    usable = pitch[np.isfinite(pitch) & voiced[: len(pitch)]]
    p10 = float(np.percentile(usable, 10)) if len(usable) else None
    p90 = float(np.percentile(usable, 90)) if len(usable) else None
    return duration, {
        "pitch_mean_hz": float(np.mean(usable)) if len(usable) else None,
        "pitch_range_hz": p90 - p10 if p10 is not None else None,
        "energy_rms_mean": float(np.mean(rms)),
        "pause_ratio": float(1.0 - np.mean(voiced)),
    }


def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


model_path = os.environ["COMPANION_SENSEVOICE_MODEL"]
with contextlib.redirect_stdout(sys.stderr):
    model = AutoModel(model=model_path, trust_remote_code=False, device="cpu", disable_update=True)
emit({"type": "ready", "backend": "CPU", "precision": "float32"})

for line in sys.stdin:
    request_id = None
    temp_path = None
    try:
        request = json.loads(line)
        request_id = str(request["id"])
        audio = base64.b64decode(request["audio_base64"], validate=True)
        with tempfile.NamedTemporaryFile(prefix="companion-sv-", suffix=".wav", delete=False) as handle:
            handle.write(audio)
            temp_path = handle.name
        duration, features = prosody(temp_path)
        started = time.perf_counter()
        with contextlib.redirect_stdout(sys.stderr):
            generated = model.generate(input=temp_path, cache={}, language="auto", use_itn=True, batch_size=1)
        inference_ms = round((time.perf_counter() - started) * 1000.0, 3)
        raw_text = str(generated[0].get("text", ""))
        emit({"type": "result", "id": request_id, **decode_result(raw_text), "prosody": features,
              "audio_duration_seconds": duration, "inference_ms": inference_ms,
              "realtime_factor": inference_ms / max(duration * 1000.0, 1e-9)})
    except Exception as error:
        emit({"type": "error", "id": request_id, "message": str(error)[:240]})
    finally:
        if temp_path:
            try:
                os.unlink(temp_path)
            except OSError:
                pass
