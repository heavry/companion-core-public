#!/usr/bin/env python3
"""Phase A/B/C/D diagnostic for Voicebox MLX Qwen3-TTS ICL.

Does not change official Voicebox 17493 or Companion routing.
Standalone experiment path only.
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import time
import traceback
from pathlib import Path

import numpy as np
import mlx.core as mx
import soundfile as sf

APP = Path.home() / "Library/Application Support/sh.voicebox.app"
MODEL_ID = "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16"
PROFILE_ID = "0763cc16-4523-4b65-90d0-823a0dfd8e5f"
MODE = sys.argv[1] if len(sys.argv) > 1 else "phase_ab"  # phase_ab | phase_c | phase_d
TEXTS = [
    "这是 Voicebox 推理分段测试。",
    "今天天气不错，想和你聊聊天。",
    "晚上记得早点休息，别熬太晚。",
]


def load_ref():
    db = sqlite3.connect(str(APP / "voicebox.db"))
    try:
        row = db.execute(
            "SELECT audio_path, reference_text FROM profile_samples WHERE profile_id=? LIMIT 1",
            (PROFILE_ID,),
        ).fetchone()
    finally:
        db.close()
    path = str(APP / row[0])
    data, sr = sf.read(path, dtype="float32")
    if data.ndim > 1:
        data = data.mean(axis=1)
    return mx.array(data), row[1], path, sr


def shape_of(x):
    try:
        if hasattr(x, "shape"):
            return tuple(int(i) for i in x.shape)
        return None
    except Exception:
        return None


def mem_mb():
    return {
        "active": round(mx.get_active_memory() / 1e6, 1),
        "peak": round(mx.get_peak_memory() / 1e6, 1),
        "cache": round(mx.get_cache_memory() / 1e6, 1),
    }


def main():
    print(f"MODE={MODE} DEVICE={mx.default_device()} metal={mx.metal.is_available()}", flush=True)
    ref_wave, ref_text, ref_path, ref_sr = load_ref()
    print(
        f"REF path={ref_path} sr={ref_sr} sec={len(np.asarray(ref_wave))/ref_sr:.2f} text_len={len(ref_text)}",
        flush=True,
    )
    from mlx_audio.tts import load_model

    t0 = time.time()
    model = load_model(MODEL_ID)
    print(f"LOAD {time.time()-t0:.3f}s mem={mem_mb()}", flush=True)

    # A1: skip periodic clear
    mx.clear_cache = lambda *a, **k: None
    import mlx.core as _m

    _m.clear_cache = mx.clear_cache

    eval_events = []
    decode_events = []
    _orig_eval = mx.eval

    def eval_wrap(*args, **kwargs):
        t = time.time()
        import sys as _sys

        fr = _sys._getframe(1)
        stack = []
        d = 0
        while fr is not None and d < 6:
            stack.append(f"{fr.f_code.co_name}:{fr.f_code.co_firstlineno}")
            fr = fr.f_back
            d += 1
        shapes = [shape_of(a) for a in args]
        r = _orig_eval(*args, **kwargs)
        dt = time.time() - t
        eval_events.append({"dt": dt, "shapes": shapes, "stack": " <- ".join(stack[:5]), "t": t})
        return r

    mx.eval = eval_wrap
    _m.eval = eval_wrap

    orig_decode = model._decode_chunk if hasattr(model, "_decode_chunk") else None
    orig_stream_decode = None
    st = getattr(model, "speech_tokenizer", None)
    if st is not None:
        dec = getattr(st, "streaming_decode", None)
        if callable(dec):
            orig_stream_decode = dec

            def sd_wrap(*a, **k):
                t = time.time()
                r = orig_stream_decode(*a, **k)
                decode_events.append({"fn": "streaming_decode", "dt": time.time() - t, "shapes": [shape_of(x) for x in a]})
                return r

            st.streaming_decode = sd_wrap
        ch = getattr(st, "chunked_decode", None)
        if callable(ch):

            def cd_wrap(*a, **k):
                t = time.time()
                r = ch(*a, **k)
                decode_events.append({"fn": "chunked_decode", "dt": time.time() - t})
                return r

            # don't replace if it's the same as streaming path

    if orig_decode:

        def dc_wrap(*a, **k):
            t = time.time()
            r = orig_decode(*a, **k)
            decode_events.append({"fn": "_decode_chunk", "dt": time.time() - t, "shapes": [shape_of(x) for x in a]})
            return r

        model._decode_chunk = dc_wrap

    results = []

    def run_generate(text, label):
        nonlocal eval_events, decode_events
        eval_events = []
        decode_events = []
        mx.reset_peak_memory()
        mem0 = mem_mb()
        t0 = time.time()
        n_tok = None
        audio = None
        try:
            out = model.generate(
                text=text,
                ref_audio=ref_wave,
                ref_text=ref_text,
                language="zh",
                max_tokens=128,
            )
            if hasattr(out, "__iter__") and not isinstance(out, (bytes, str, np.ndarray)):
                for item in out:
                    if hasattr(item, "audio"):
                        audio = item.audio
                        n_tok = getattr(item, "token_count", None)
                    elif isinstance(item, tuple) and len(item) >= 2:
                        audio = item[0]
            else:
                audio = out
        except Exception:
            print("ERR", traceback.format_exc(), flush=True)
            return None
        wall = time.time() - t0
        mem1 = mem_mb()
        audio_s = None
        if audio is not None:
            a = np.asarray(audio)
            sr = getattr(model, "sample_rate", 24000)
            audio_s = float(a.shape[-1] / float(sr))
        # summarize evals
        big = sorted(eval_events, key=lambda e: -e["dt"])[:6]
        row = {
            "label": label,
            "wall_s": round(wall, 3),
            "n_eval": len(eval_events),
            "eval_sum_s": round(sum(e["dt"] for e in eval_events), 3),
            "n_decode_hooks": len(decode_events),
            "decode_sum_s": round(sum(d["dt"] for d in decode_events), 3),
            "audio_sec": round(audio_s, 3) if audio_s else None,
            "tokens": n_tok,
            "mem0": mem0,
            "mem1": mem1,
            "top_evals": [
                {"dt": round(e["dt"], 3), "shapes": e["shapes"], "stack": e["stack"][:80]}
                for e in big
            ],
            "decode_events": [
                {"fn": d["fn"], "dt": round(d["dt"], 3), "shapes": d.get("shapes")} for d in decode_events
            ],
        }
        print("RESULT", json.dumps(row, ensure_ascii=False), flush=True)
        results.append(row)
        return row

    # ---------- Phase A: prepare structure ----------
    text0 = TEXTS[0]
    print("\n=== PHASE A prepare structure ===", flush=True)
    t_prep = time.time()
    input_embeds, trailing, pad, ref_codes = model._prepare_icl_generation_inputs(
        text=text0, ref_audio=ref_wave, ref_text=ref_text, language="zh"
    )
    prep_s = time.time() - t_prep
    # eval prepare outputs
    t_e = time.time()
    mx.eval(input_embeds, trailing, pad, ref_codes)
    eval_prep = time.time() - t_e
    print(
        json.dumps(
            {
                "prepare_wall_s": round(prep_s, 3),
                "explicit_eval_outputs_s": round(eval_prep, 3),
                "input_embeds": shape_of(input_embeds),
                "trailing_text_hidden": shape_of(trailing),
                "tts_pad_embed": shape_of(pad),
                "ref_codes": shape_of(ref_codes),
                "target_text_len": len(text0),
                "ref_text_len": len(ref_text),
                "note": "FIXED=ref_codes+speaker+ref_text path; DYNAMIC=target text embeds in input_embeds tail + trailing_text_hidden",
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    fixed_prefix = {
        "ref_codes": shape_of(ref_codes),
        "ref_codes_len": shape_of(ref_codes)[-1] if shape_of(ref_codes) else None,
        "input_embeds_total": shape_of(input_embeds)[-2] if shape_of(input_embeds) else None,
        "trailing_len": shape_of(trailing)[-2] if shape_of(trailing) else None,
    }
    print("FIXED_PREFIX_BOUNDARY", json.dumps(fixed_prefix, ensure_ascii=False), flush=True)
    print(
        "DYNAMIC_TARGET_BEGINS_HERE trailing_text_hidden + AR from full input_embeds prefill on first talker()",
        flush=True,
    )

    if MODE == "phase_ab":
        # Baseline generation
        print("\n=== BASELINE ===", flush=True)
        run_generate(text0, "baseline_uncached")

        # Phase B: materialize prepare graph explicitly, then generate same text
        # (generate will re-prepare; we measure by wrapping prepare to eval before return)
        print("\n=== PHASE B explicit materialize before AR ===", flush=True)
        orig_prep = model._prepare_icl_generation_inputs

        def prep_and_materialize(*a, **k):
            t = time.time()
            out = orig_prep(*a, **k)
            t2 = time.time()
            mx.eval(*out)
            t3 = time.time()
            prep_and_materialize.times.append((t2 - t, t3 - t2))
            return out

        prep_and_materialize.times = []
        model._prepare_icl_generation_inputs = prep_and_materialize
        eval_events = []
        run_generate(text0, "phase_b_materialize")
        model._prepare_icl_generation_inputs = orig_prep
        if prep_and_materialize.times:
            print(
                "PHASE_B_PREP_SPLIT",
                json.dumps(
                    [
                        {"build_s": round(a, 3), "materialize_s": round(b, 3)}
                        for a, b in prep_and_materialize.times
                    ]
                ),
                flush=True,
            )
        # Print first 8 evals of baseline vs phase_b from results
        for r in results:
            print(f"TOP_EVALS {r['label']}", json.dumps(r["top_evals"][:5], ensure_ascii=False), flush=True)

    if MODE == "phase_c":
        print("\n=== PHASE C ref_codes + prefix materialize cache ===", flush=True)
        # Cache prepare outputs' FIXED parts: ref_codes; reuse by short-circuiting encode
        cache = {}

        def prep_cached(text, ref_audio=None, ref_text=None, language="zh", **k):
            key = ("ref", id(ref_audio) if hasattr(ref_audio, "shape") else ref_text)
            # Always need full prepare for target text; only skip ref encode by patching speech_tokenizer.encode
            return orig_prep(text=text, ref_audio=ref_audio, ref_text=ref_text, language=language)

        # Cache ref_codes only via encode wrapper
        if st is not None and hasattr(st, "encode"):
            _enc = st.encode
            enc_n = [0]

            def enc_cached(audio, *a, **k):
                if "codes" not in cache:
                    cache["codes"] = _enc(audio, *a, **k)
                    enc_n[0] += 1
                return cache["codes"]

            st.encode = enc_cached
        else:
            enc_n = [0]

        # Also cache prepare for same text only — for multi-text we rebuild text part
        prep_cache = {}

        def prep_reuse_fixed(text, ref_audio=None, ref_text=None, language="zh", **k):
            # full prepare still runs (target-dependent), but encode is cached
            return model.__class__._prepare_icl_generation_inputs(
                model, text=text, ref_audio=ref_audio, ref_text=ref_text, language=language
            )

        # Use method directly with encode cache
        uncached_times = []
        cached_times = []
        for i, text in enumerate(TEXTS):
            # clear encode cache between "uncached" and "cached" phases
            if i == 0:
                cache.clear()
                if st is not None and hasattr(st, "encode"):
                    st.encode = _enc  # reset
            run_generate(text, f"c{i}_uncached" if i == 0 else f"c{i}")
        # rebuild encode cache once
        if st is not None and hasattr(st, "encode"):
            cache.clear()
            st.encode = enc_cached
        for i, text in enumerate(TEXTS):
            run_generate(text, f"cached_encode_{i}")

        # Try materialize-only prefix: eval ref_codes + pad once, reuse across gens
        print("PHASE_C_MEM_PEAKS", json.dumps([r["mem1"] for r in results], ensure_ascii=False), flush=True)
        print(
            "PHASE_C_WALLS",
            json.dumps(
                [
                    {"label": r["label"], "wall": r["wall_s"], "audio": r["audio_sec"], "mem_peak": r["mem1"]["peak"]}
                    for r in results
                ],
                ensure_ascii=False,
            ),
            flush=True,
        )

    if MODE == "phase_d":
        print("\n=== PHASE D decode split ===", flush=True)
        # Capture decode internals more finely
        st = getattr(model, "speech_tokenizer", None)
        dec = getattr(st, "decoder", None) if st else None
        hooks = {}

        def wrap_fn(obj, name, tag):
            if obj is None or not hasattr(obj, name):
                return
            fn = getattr(obj, name)
            if not callable(fn):
                return

            def w(*a, **k):
                t = time.time()
                r = fn(*a, **k)
                hooks.setdefault(tag, []).append(time.time() - t)
                return r

            setattr(obj, name, w)

        if st:
            wrap_fn(st, "streaming_decode", "streaming_decode")
            wrap_fn(st, "chunked_decode", "chunked_decode")
            wrap_fn(st, "decode", "decode")
            if dec is not None:
                wrap_fn(dec, "decode", "decoder.decode")
                wrap_fn(dec, "forward", "decoder.forward")
        wrap_fn(model, "_decode_chunk", "_decode_chunk")
        wrap_fn(model, "decode", "model.decode")

        # Also time wav_write path in generate — wrap after generate manually by decoding codes only
        run_generate(text0, "d0_decode_instrument")

        print("DECODE_HOOKS", json.dumps({k: [round(x, 3) for x in v] for k, v in hooks.items()}, ensure_ascii=False), flush=True)
        print("DECODE_EVENTS", json.dumps(results[-1]["decode_events"] if results else [], ensure_ascii=False), flush=True)

        # Standalone decode compile experiment: decode a dummy tensor if decoder available
        if st is not None and hasattr(st, "streaming_decode"):
            print("compile_decode_skipped_need_valid_codes_shape", flush=True)

    print("SUMMARY", json.dumps({"mode": MODE, "results": results}, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
