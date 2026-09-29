#!/usr/bin/env python3
"""Private JSON-lines sherpa-onnx KeywordSpotter. Audio stays in memory and is never written."""
import base64
import json
import os
import sys

import numpy as np


def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def resample(audio, source_rate, target_rate=16000):
    if source_rate <= 0 or abs(source_rate - target_rate) < 0.75:
        return audio.astype(np.float32)
    ratio = source_rate / target_rate
    count = max(1, int(len(audio) / ratio))
    x_old = np.linspace(0.0, 1.0, num=len(audio), endpoint=False)
    x_new = np.linspace(0.0, 1.0, num=count, endpoint=False)
    return np.interp(x_new, x_old, audio).astype(np.float32)


def pcm16_to_float(raw):
    return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0


def load_spotter():
    import sherpa_onnx

    model = os.environ["COMPANION_WAKE_WORD_MODEL"]
    keywords = os.environ["COMPANION_WAKE_WORD_KEYWORDS"]
    threshold = float(os.environ.get("COMPANION_WAKE_WORD_THRESHOLD", "0.25"))
    encoder = os.path.join(model, "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx")
    decoder = os.path.join(model, "decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx")
    joiner = os.path.join(model, "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx")
    tokens = os.path.join(model, "tokens.txt")
    return sherpa_onnx.KeywordSpotter(
        tokens=tokens,
        encoder=encoder,
        decoder=decoder,
        joiner=joiner,
        keywords_file=keywords,
        num_threads=1,
        sample_rate=16000,
        max_active_paths=4,
        keywords_score=1.0,
        keywords_threshold=threshold,
        num_trailing_blanks=1,
        provider="cpu",
    )


try:
    spotter = load_spotter()
    stream = spotter.create_stream()
    emit({"type": "ready", "engine": "sherpa-onnx", "quantization": "int8"})
except Exception as error:
    emit({"type": "error", "message": "wake-word runtime failed to start"})
    sys.stderr.write(str(error) + "\n")
    sys.exit(1)


for line in sys.stdin:
    try:
        request = json.loads(line)
        kind = request.get("type")
        if kind == "stop":
            break
        if kind == "reset":
            stream = spotter.create_stream()
            emit({"type": "chunk_ok"})
            continue
        if kind != "audio":
            emit({"type": "chunk_ok"})
            continue
        raw = base64.b64decode(request.get("pcm16_base64") or "", validate=False)
        audio = pcm16_to_float(raw)
        audio = resample(audio, float(request.get("sample_rate") or 16000))
        stream.accept_waveform(16000, audio)
        while spotter.is_ready(stream):
            spotter.decode_stream(stream)
            result = spotter.get_result(stream)
            if result:
                emit({"type": "detection", "keyword": str(result), "score": 1.0})
                spotter.reset_stream(stream)
        emit({"type": "chunk_ok"})
    except Exception as error:
        emit({"type": "error", "message": "wake-word chunk failed"})
        sys.stderr.write(str(error) + "\n")
