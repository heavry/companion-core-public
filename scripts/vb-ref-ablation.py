#!/usr/bin/env python3
"""Reference duration ablation for Voicebox MLX Qwen3-TTS clone."""
from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import mlx.core as mx
import soundfile as sf

OUT = Path(__file__).resolve().parent.parent / "data" / "voice-ablation"
MODEL_ID = "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16"
REFS = {
    "30s": OUT / "ref30.wav",
    "20s": OUT / "ref20.wav",
    "15s": OUT / "ref15.wav",
    "10s": OUT / "ref10.wav",
    "8s": OUT / "ref8.wav",
}
# Same transcript family as profile; truncated roughly for shorter refs
REF_TEXTS = {
    "30s": "回来了。你还知道回来。别碰我。我让你别碰我。生气。我怎么有胆子跟你生气。我现在被你关在这里，哪里都去不了。我有什么好生气的。",
    "20s": "回来了。你还知道回来。别碰我。我让你别碰我。生气。我现在被你关在这里，哪里都去不了。",
    "15s": "回来了。你还知道回来。别碰我。我让你别碰我。生气。",
    "10s": "回来了。你还知道回来。别碰我。我让你别碰我。",
    "8s": "回来了。你还知道回来。别碰我。",
}
TEXTS = [
    ("short", "宝宝我回来啦。"),
    ("med", "你今天是不是有点累呀，要不要先歇一会儿？"),
    ("mood_a", "别碰我，我生气了。"),
    ("mood_b", "哼，你怎么才回来。"),
]
MAX_TOKENS = int(sys.argv[1]) if len(sys.argv) > 1 else 75


def load_wave(path: Path):
    data, sr = sf.read(str(path), dtype="float32")
    if data.ndim > 1:
        data = data.mean(axis=1)
    # speaker mel wants [batch, samples]; speech encoder wants [batch, ch, samples]
    batch = data[None, :]
    channels = data[None, None, :]
    return {
        "batch": mx.array(batch),
        "channels": mx.array(channels),
        "sr": sr,
        "sec": data.shape[0] / sr,
        "samples": int(data.shape[0]),
    }


def encode_len(model, wave, ref_text):
    t = time.time()
    codes = model.speech_tokenizer.encode(wave["channels"])
    mx.eval(codes)
    dt = time.time() - t
    shape = tuple(int(i) for i in codes.shape)
    tlen = shape[-1] if len(shape) == 3 else None
    return {"encode_s": round(dt, 4), "codes_shape": list(shape), "ref_tokens": tlen}


def prep_len(model, text, wave, ref_text):
    t = time.time()
    ie, thr, pad, codes = model._prepare_icl_generation_inputs(
        text=text, ref_audio=wave["batch"], ref_text=ref_text, language="zh"
    )
    mx.eval(ie, thr, pad, codes)
    return {
        "prep_s": round(time.time() - t, 3),
        "seq_len": int(ie.shape[1]),
        "hidden": int(ie.shape[2]),
        "ref_codes_T": int(codes.shape[-1]) if codes.ndim == 3 else None,
    }


def run_gen(model, text, wave, ref_text, max_tokens):
    mx.reset_peak_memory()
    t0 = time.time()
    evals = []
    _oe = mx.eval

    def ev(*a, **k):
        te = time.time()
        r = _oe(*a, **k)
        evals.append(time.time() - te)
        return r

    mx.eval = ev
    import mlx.core as _m

    _m.eval = ev
    try:
        out = model.generate(
            text=text, ref_audio=wave["batch"], ref_text=ref_text, language="zh", max_tokens=max_tokens
        )
        n_tok = None
        audio = None
        for item in out:
            if hasattr(item, "audio"):
                audio = item.audio
                n_tok = getattr(item, "token_count", None)
    finally:
        mx.eval = _oe
        _m.eval = _oe
    wall = time.time() - t0
    audio_s = None
    if audio is not None:
        audio_s = float(np.asarray(audio).shape[-1] / float(getattr(model, "sample_rate", 24000)))
    big = sorted(evals, reverse=True)[:3]
    return {
        "wall_s": round(wall, 3),
        "audio_sec": round(audio_s, 3) if audio_s else None,
        "tokens": n_tok,
        "rtf": round(wall / audio_s, 2) if audio_s else None,
        "top_eval_s": [round(x, 3) for x in big],
        "peak_mb": round(mx.get_peak_memory() / 1e6, 1),
    }


def main():
    print(f"DEVICE={mx.default_device()} MAX_TOKENS={MAX_TOKENS}", flush=True)
    from mlx_audio.tts import load_model

    t0 = time.time()
    model = load_model(MODEL_ID)
    print(f"LOAD {time.time()-t0:.2f}s", flush=True)
    mx.clear_cache = lambda *a, **k: None
    import mlx.core as _m

    _m.clear_cache = mx.clear_cache

    waves = {}
    for name, path in REFS.items():
        w = load_wave(path)
        waves[name] = w
        print(f"REF {name} sec={w['sec']:.2f} sr={w['sr']}", flush=True)

    # encode + prep metrics using first target text
    ref_metrics = {}
    for name, w in waves.items():
        enc = encode_len(model, w, REF_TEXTS[name])
        prep = prep_len(model, TEXTS[0][1], w, REF_TEXTS[name])
        ref_metrics[name] = {**enc, **prep, "ref_sec": round(float(w["sec"]), 2)}
        print("REF_METRICS", json.dumps({"ref": name, **ref_metrics[name]}, ensure_ascii=False), flush=True)

    # Full generate: warmup once on 30s, then for each ref warm×1 short + all 5 texts ×1
    # To keep time reasonable: for each ref, warmup short once, then 5 texts once
    results = []
    for name, w in waves.items():
        rtext = REF_TEXTS[name]
        # warmup
        run_gen(model, "好的。", w, rtext, max_tokens=min(MAX_TOKENS, 16))
        for tname, text in TEXTS:
            g = run_gen(model, text, w, rtext, max_tokens=MAX_TOKENS)
            row = {"ref": name, "text": tname, **ref_metrics[name], **g}
            results.append(row)
            print("GEN", json.dumps(row, ensure_ascii=False), flush=True)

    # Aggregate per ref
    agg = {}
    for name in REFS:
        rows = [r for r in results if r["ref"] == name and r["text"] != "short2"]
        if not rows:
            continue
        agg[name] = {
            "ref_tokens": rows[0]["ref_tokens"],
            "seq_len": rows[0]["seq_len"],
            "prep_s_mean": round(sum(r["prep_s"] for r in rows) / len(rows), 3),
            "wall_mean": round(sum(r["wall_s"] for r in rows) / len(rows), 3),
            "wall_short": next((r["wall_s"] for r in rows if r["text"] == "short"), None),
            "wall_med": next((r["wall_s"] for r in rows if r["text"] == "med"), None),
            "audio_mean": round(sum(r["audio_sec"] for r in rows if r["audio_sec"]) / len(rows), 3),
            "tokens_mean": round(sum(r["tokens"] for r in rows if r["tokens"]) / len(rows), 1),
            "peak_mb_max": max(r["peak_mb"] for r in rows),
            "rtf_mean": round(sum(r["rtf"] for r in rows if r["rtf"]) / len([r for r in rows if r["rtf"]]), 2),
        }
    print("AGG", json.dumps(agg, ensure_ascii=False, indent=2), flush=True)
    (OUT / "ablation_results.json").write_text(
        json.dumps({"ref_metrics": ref_metrics, "results": results, "agg": agg}, ensure_ascii=False, indent=2)
    )
    print(f"WROTE {OUT/'ablation_results.json'}", flush=True)


if __name__ == "__main__":
    main()
