#!/usr/bin/env python3
"""A/B/C experiments for Voicebox MLX Qwen3-TTS ICL path.

Usage: vb-exp.py [variant] [runs]
  variant: a0 | a1 | b_async | b_sync_opt | control
"""
import os, sys, time, json, sqlite3, traceback, types
from pathlib import Path
import numpy as np
import mlx.core as mx

VARIANT = sys.argv[1] if len(sys.argv) > 1 else "a0"
RUNS = int(sys.argv[2]) if len(sys.argv) > 2 else 3
TEXT = "这是 Voicebox 推理分段测试。"
APP = Path.home() / "Library/Application Support/sh.voicebox.app"
MODEL_ID = "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16"
PROFILE_ID = "0763cc16-4523-4b65-90d0-823a0dfd8e5f"

print(f"VARIANT={VARIANT} DEVICE={mx.default_device()} metal={mx.metal.is_available()}", flush=True)

import soundfile as sf
db = sqlite3.connect(str(APP / "voicebox.db"))
row = db.execute(
    "SELECT audio_path, reference_text FROM profile_samples WHERE profile_id=?",
    (PROFILE_ID,),
).fetchone()
db.close()
ref_path = str(APP / row[0])
ref_text = row[1]
data, sr = sf.read(ref_path, dtype="float32")
if data.ndim > 1:
    data = data.mean(1)
ref_wave = mx.array(data)
print(f"REF sec={len(data)/sr:.2f} text_len={len(ref_text)}", flush=True)

from mlx_audio.tts import load_model

t = time.time()
model = load_model(MODEL_ID)
load_s = time.time() - t
print(f"LOAD {load_s:.3f}s active_mb={mx.get_active_memory()/1e6:.1f}", flush=True)

# ---------- instrumentation state ----------
stats = {
    "eval_calls": 0,
    "eval_s": 0.0,
    "eval_events": [],  # (t_wall, duration_s, n_args)
    "async_calls": 0,
    "clear_cache_calls": [],
    "token_times": [],  # (step_index, t_wall_rel, eval_s_this_step_approx)
    "prepare_s": None,
    "encode_s": None,
}

_orig_eval = mx.eval
_orig_async = getattr(mx, "async_eval", None)
_orig_clear = mx.clear_cache
_orig_prep = model._prepare_icl_generation_inputs
_orig_sample = model._sample_token
_orig_genicl = model._generate_icl

# Track prepare / encode
def prep_wrap(*a, **k):
    t0 = time.time()
    r = _orig_prep(*a, **k)
    stats["prepare_s"] = time.time() - t0
    return r

model._prepare_icl_generation_inputs = prep_wrap

st = getattr(model, "speech_tokenizer", None)
if st is not None and hasattr(st, "encode"):
    _oe = st.encode

    def enc_wrap(*a, **k):
        t0 = time.time()
        r = _oe(*a, **k)
        stats["encode_s"] = time.time() - t0
        return r

    st.encode = enc_wrap

# eval wrapper with per-call timing
def eval_wrap(*args, **kwargs):
    t0 = time.time()
    r = _orig_eval(*args, **kwargs)
    dt = time.time() - t0
    stats["eval_calls"] += 1
    stats["eval_s"] += dt
    stats["eval_events"].append((t0, dt, len(args)))
    return r

def clear_wrap(*args, **kwargs):
    stats["clear_cache_calls"].append(time.time())
    return _orig_clear(*args, **kwargs)

# Install wrappers on module used by model code
import mlx.core as _mxmod
_mxmod.eval = eval_wrap
mx.eval = eval_wrap
mx.clear_cache = clear_wrap

# Variant-specific clear_cache policy
if VARIANT in ("a1", "b_async", "b_sync_opt"):
    # A1: suppress periodic mid-loop clear_cache (step%50). Keep end clear.
    # Implement by counting: first ~N clears are mid-loop for 75-token gen; allow last one.
    _clear_n = [0]

    def clear_wrap_a1(*args, **kwargs):
        _clear_n[0] += 1
        # For ~75 token gen: mid-loop clears at step 50 only (1), streaming maybe 0 if not stream, end 1.
        # We allow only the last clear (end of generation) by deferring decision:
        # simpler: skip clears that happen while < 60s from start of gen after first 2s.
        stats["clear_cache_calls"].append(time.time())
        # skip mid-loop: if we've already cleared once this "session", skip until gen ends
        # Better approach: skip if clear happens more than 2s after start and before last 1s of expected gen
        return None  # skip actual clear for A1

    if VARIANT == "a1":
        mx.clear_cache = clear_wrap_a1
        _mxmod.clear_cache = clear_wrap_a1

# Variant B: async_eval for eval of tensors, then sample still gets values
# We cannot easily change _generate_icl internals; instead:
# - b_async: make eval = async_eval without wait (dangerous for correctness of sample)
#   so we only async_eval then immediately sync via eval on same args if needed.
# Better B approach used below after load: wrap eval to try async then not block twice.

if VARIANT == "b_async" and _orig_async is not None:
    def eval_async_wrap(*args, **kwargs):
        t0 = time.time()
        # schedule async, then block once (same as eval but may overlap with host work)
        try:
            r = _orig_async(*args, **kwargs)
            # async_eval returns None typically; materialize by eval
            r2 = _orig_eval(*args, **kwargs)
            dt = time.time() - t0
            stats["async_calls"] += 1
            stats["eval_calls"] += 1
            stats["eval_s"] += dt
            stats["eval_events"].append((t0, dt, len(args)))
            return r2 if r2 is not None else r
        except Exception:
            return _orig_eval(*args, **kwargs)

    mx.eval = eval_async_wrap
    _mxmod.eval = eval_async_wrap

# b_sync_opt: only reduce redundant evals by coalescing — not changing algorithm;
# placeholder no-op beyond a1 (document that B needs deeper loop rewrite)
if VARIANT == "b_sync_opt":
    # no-op beyond a1 clear policy already applied
    pass

# sample wrapper records token step
_tok_i = [0]


def sample_wrap(*a, **k):
    t0 = time.time()
    r = _orig_sample(*a, **k)
    _tok_i[0] += 1
    stats["token_times"].append((_tok_i[0], t0, time.time() - t0))
    return r


model._sample_token = sample_wrap


def run_one(run_idx):
    stats["eval_calls"] = 0
    stats["eval_s"] = 0.0
    stats["eval_events"] = []
    stats["async_calls"] = 0
    stats["clear_cache_calls"] = []
    stats["token_times"] = []
    stats["prepare_s"] = None
    stats["encode_s"] = None
    _tok_i[0] = 0
    if VARIANT == "a1":
        # reset clear policy: skip all clears (safe enough for 75 tok, end clear skipped too)
        pass

    mx.reset_peak_memory()
    mem0 = mx.get_peak_memory()
    t0 = time.time()
    audio = None
    rate = None
    n_tokens_out = None
    try:
        out = model.generate(
            text=TEXT,
            ref_audio=ref_wave,
            ref_text=ref_text,
            language="zh",
            max_tokens=128,
        )
        if hasattr(out, "__iter__") and not isinstance(out, (bytes, str, np.ndarray)):
            for item in out:
                if hasattr(item, "audio"):
                    audio = item.audio
                    rate = getattr(item, "sample_rate", getattr(model, "sample_rate", 24000))
                    n_tokens_out = getattr(item, "token_count", None)
                elif isinstance(item, tuple) and len(item) >= 2:
                    audio, rate = item[0], item[1]
        elif isinstance(out, tuple):
            audio, rate = out[0], out[1]
        else:
            audio = out
    except Exception:
        print("ERR", traceback.format_exc(), flush=True)
        return None

    wall = time.time() - t0
    peak = mx.get_peak_memory()
    audio_sec = None
    if audio is not None:
        try:
            arr = np.asarray(audio)
            audio_sec = arr.shape[-1] / float(rate or 24000)
        except Exception:
            try:
                audio_sec = len(audio) / float(rate or 24000)
            except Exception:
                pass

    # per-token latency from eval events interleaved with samples
    # Approximate TTFT: time of first sample_wrap relative to t0
    first_tok = stats["token_times"][0][1] - t0 if stats["token_times"] else None
    last_tok = stats["token_times"][-1][1] - t0 if stats["token_times"] else None
    # gaps between samples
    gaps = []
    tt = stats["token_times"]
    for i in range(1, len(tt)):
        gaps.append(tt[i][1] - tt[i - 1][1])

    # eval duration percentiles
    durs = [e[1] for e in stats["eval_events"]]
    peak_eval = max(durs) if durs else 0

    row = {
        "variant": VARIANT,
        "run": run_idx,
        "wall_s": round(wall, 3),
        "prepare_s": round(stats["prepare_s"], 3) if stats["prepare_s"] is not None else None,
        "encode_s": round(stats["encode_s"], 4) if stats["encode_s"] is not None else None,
        "n_sample_calls": len(stats["token_times"]),
        "eval_calls": stats["eval_calls"],
        "eval_total_s": round(stats["eval_s"], 3),
        "eval_peak_s": round(peak_eval, 3),
        "async_calls": stats["async_calls"],
        "clear_cache_n": len(stats["clear_cache_calls"]),
        "ttft_sample_s": round(first_tok, 3) if first_tok is not None else None,
        "last_sample_s": round(last_tok, 3) if last_tok is not None else None,
        "mean_tok_gap_ms": round(1000 * sum(gaps) / len(gaps), 1) if gaps else None,
        "median_tok_gap_ms": round(1000 * sorted(gaps)[len(gaps) // 2], 1) if gaps else None,
        "tok_per_s_from_gaps": round(len(gaps) / sum(gaps), 3) if gaps and sum(gaps) > 0 else None,
        "audio_sec": round(audio_sec, 3) if audio_sec else None,
        "rtf": round(wall / audio_sec, 2) if audio_sec else None,
        "peak_metal_mb": round(peak / 1e6, 1),
        "token_count_meta": n_tokens_out,
        "device": str(mx.default_device()),
        "eval_frac_wall": round(stats["eval_s"] / wall, 3) if wall else None,
    }
    # per-token series (compressed): first 5, last 5, and growth ratio
    if gaps:
        row["gap_first5_ms"] = [round(g * 1000, 1) for g in gaps[:5]]
        row["gap_last5_ms"] = [round(g * 1000, 1) for g in gaps[-5:]]
        if len(gaps) >= 10:
            early = sum(gaps[:5]) / 5
            late = sum(gaps[-5:]) / 5
            row["gap_late_over_early"] = round(late / early, 3) if early else None
    return row


results = []
for i in range(1, RUNS + 1):
    row = run_one(i)
    if row:
        results.append(row)
        print("RESULT", json.dumps(row, ensure_ascii=False), flush=True)

print("SUMMARY", json.dumps({"variant": VARIANT, "results": results}, ensure_ascii=False, indent=2), flush=True)
