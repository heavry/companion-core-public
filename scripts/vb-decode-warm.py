#!/usr/bin/env python3
"""Phase A: isolate waveform decode; warm×5; optional compile A/B.

Saves codes from first generate, then repeatedly decodes only.
"""
from __future__ import annotations

import json
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
MODE = sys.argv[1] if len(sys.argv) > 1 else "decode_warm"  # decode_warm | decode_compile | startup
TEXT = sys.argv[2] if len(sys.argv) > 2 else "宝宝我回来啦。"
CODES_PATH = Path("/tmp/vb-saved-codes.npz")


def load_ref():
    db = sqlite3.connect(str(APP / "voicebox.db"))
    row = db.execute(
        "SELECT audio_path, reference_text FROM profile_samples WHERE profile_id=?",
        (PROFILE_ID,),
    ).fetchone()
    db.close()
    data, _ = sf.read(str(APP / row[0]), dtype="float32")
    if data.ndim > 1:
        data = data.mean(axis=1)
    return mx.array(data), row[1]


def mem():
    return {
        "active": round(mx.get_active_memory() / 1e6, 1),
        "peak": round(mx.get_peak_memory() / 1e6, 1),
        "cache": round(mx.get_cache_memory() / 1e6, 1),
    }


def shape_of(x):
    try:
        return tuple(int(i) for i in x.shape) if hasattr(x, "shape") else None
    except Exception:
        return None


def main():
    print(f"MODE={MODE} TEXT={TEXT[:30]!r} DEVICE={mx.default_device()}", flush=True)
    ref_wave, ref_text = load_ref()
    from mlx_audio.tts import load_model

    t0 = time.time()
    model = load_model(MODEL_ID)
    print(f"LOAD {time.time()-t0:.3f}s mem={mem()}", flush=True)
    mx.clear_cache = lambda *a, **k: None
    import mlx.core as _m

    _m.clear_cache = mx.clear_cache

    st = model.speech_tokenizer
    saved_codes = {"arr": None, "n": 0}

    # Capture codes entering decode
    _dec = st.decode
    _sdec = st.streaming_decode

    def dec_wrap(codes, *a, **k):
        if saved_codes["arr"] is None:
            mx.eval(codes)
            saved_codes["arr"] = np.asarray(mx.array(codes))
            saved_codes["n"] += 1
            print(
                f"CAPTURE codes shape={shape_of(codes)} meta={mx.array(codes).dtype}",
                flush=True,
            )
        return _dec(codes, *a, **k)

    def sdec_wrap(*a, **k):
        # first arg often codes
        if a and saved_codes["arr"] is None and hasattr(a[0], "shape"):
            mx.eval(a[0])
            saved_codes["arr"] = np.asarray(mx.array(a[0]))
            saved_codes["n"] += 1
            print(f"CAPTURE sdec codes shape={shape_of(a[0])}", flush=True)
        return _sdec(*a, **k)

    st.decode = dec_wrap
    st.streaming_decode = sdec_wrap

    # Also wrap model.decode / _decode_chunk if present
    if hasattr(model, "decode"):
        _md = model.decode

        def md_wrap(*a, **k):
            print(f"model.decode args shapes={[shape_of(x) for x in a]}", flush=True)
            t = time.time()
            r = _md(*a, **k)
            print(f"model.decode wall={time.time()-t:.3f} out={shape_of(r) if not isinstance(r, tuple) else [shape_of(x) for x in r]}", flush=True)
            return r

        model.decode = md_wrap

    def to_np(x):
        mx.eval(x)
        return np.array(x, copy=True)

    def one_decode(codes_np, label):
        # SpeechTokenizer.decoder expects [batch, num_q, time]
        arr_in = np.asarray(codes_np)
        if arr_in.ndim == 3 and arr_in.shape[1] == 16 and arr_in.shape[2] != 16:
            tq = mx.array(arr_in.astype(np.int32))  # already [1,16,T]
        elif arr_in.ndim == 3:
            tq = mx.array(np.transpose(arr_in, (0, 2, 1)).astype(np.int32))
        else:
            tq = mx.array(arr_in.astype(np.int32))
        mx.reset_peak_memory()
        mem0 = mem()
        t_build = time.time()
        try:
            audio = st.decoder(tq)
            t_after_call = time.time()
            mx.eval(audio)
            t_eval = time.time() - t_after_call
        except Exception:
            print("DECODE_ERR", traceback.format_exc(), flush=True)
            return None
        wall = time.time() - t_build
        mem1 = mem()
        arr = to_np(audio)
        # squeeze [1,1,S] or [1,S]
        if arr.ndim == 3:
            arr = arr[0, 0]
        elif arr.ndim == 2:
            arr = arr[0]
        samples = int(arr.shape[-1]) if arr.ndim else int(arr.size)
        model_sr = int(getattr(model, "sample_rate", 24000))
        audio_s = samples / float(model_sr)
        row = {
            "label": label,
            "wall_s": round(wall, 3),
            "call_to_eval_done_s": round(t_after_call - t_build, 3),
            "post_call_extra_s": round(t_eval, 3),
            "codes_shape_in": list(arr_in.shape),
            "codes_shape_tq": list(tq.shape),
            "audio_shape": list(arr.shape),
            "audio_sec": round(audio_s, 3),
            "peak_mb": mem1["peak"],
            "active_mb": mem1["active"],
            "device": str(mx.default_device()),
        }
        print("DECODE", json.dumps(row, ensure_ascii=False), flush=True)
        return row

    if MODE == "startup":
        # D: no user voice; one silent warmup inference then measure first real gen
        print("=== STARTUP WARMUP ===", flush=True)
        # warmup: generate tiny text but discard
        t0 = time.time()
        try:
            out = model.generate(
                text="…", ref_audio=ref_wave, ref_text=ref_text, language="zh", max_tokens=8
            )
            for item in out:
                pass
        except Exception:
            print("warmup_err", traceback.format_exc(), flush=True)
        print(f"WARMUP_WALL {time.time()-t0:.3f} saved_codes={saved_codes['n']}", flush=True)
        # clear saved so next capture is fresh? keep codes for decode bench
        saved_codes["arr"] = None
        t1 = time.time()
        try:
            out = model.generate(
                text=TEXT, ref_audio=ref_wave, ref_text=ref_text, language="zh", max_tokens=128
            )
            audio = None
            n_tok = None
            for item in out:
                if hasattr(item, "audio"):
                    audio = item.audio
                    n_tok = getattr(item, "token_count", None)
            wall = time.time() - t1
            audio_s = float(np.asarray(audio).shape[-1] / float(getattr(model, "sample_rate", 24000))) if audio is not None else None
            print(
                "FIRST_USER_GEN",
                json.dumps({"wall_s": round(wall, 3), "audio_sec": audio_s, "tokens": n_tok, "peak_mb": mem()["peak"]}),
                flush=True,
            )
        except Exception:
            print("first_gen_err", traceback.format_exc(), flush=True)
        print("SUMMARY", json.dumps({"mode": MODE}), flush=True)
        return

    # Capture codes via one full generate (or load saved)
    if CODES_PATH.exists() and MODE != "capture":
        data = np.load(CODES_PATH)
        codes_np = data["codes"]
        print(f"LOADED_CODES {codes_np.shape} from {CODES_PATH}", flush=True)
    else:
        print("=== CAPTURE via generate ===", flush=True)
        t0 = time.time()
        try:
            out = model.generate(
                text=TEXT, ref_audio=ref_wave, ref_text=ref_text, language="zh", max_tokens=128
            )
            n_tok = None
            for item in out:
                if hasattr(item, "audio"):
                    n_tok = getattr(item, "token_count", None)
            print(f"CAPTURE_GEN wall={time.time()-t0:.3f} tokens={n_tok} codes_n={saved_codes['n']}", flush=True)
        except Exception:
            print("capture_err", traceback.format_exc(), flush=True)
        if saved_codes["arr"] is None:
            print("NO_CODES_CAPTURED", flush=True)
            # fallback: encode ref only won't give generated codes — abort
            return
        codes_np = saved_codes["arr"]
        np.savez_compressed(CODES_PATH, codes=codes_np)
        print(f"SAVED {CODES_PATH} {codes_np.shape}", flush=True)

    # Inspect decoder structure
    dec = getattr(st, "decoder", None)
    print(
        "DECODER",
        json.dumps(
            {
                "type": type(dec).__name__ if dec else None,
                "methods": [m for m in dir(dec) if not m.startswith("_")] if dec else [],
                "codes_dtype": str(codes_np.dtype),
                "codes_shape": list(codes_np.shape),
            }
        ),
        flush=True,
    )

    # Warm decode ×5
    print("=== DECODE WARM ===", flush=True)
    rows = []
    for i in range(1, 6):
        r = one_decode(codes_np, f"warm{i}")
        if r:
            rows.append(r)

    if MODE == "decode_compile" and dec is not None:
        print("=== COMPILE DECODE ===", flush=True)
        # Try mx.compile on decoder.__call__ if stable signature
        try:
            original_call = dec.__call__

            def compiled_call(*a, **k):
                return original_call(*a, **k)

            # MLX compile of bound method
            if hasattr(mx, "compile"):
                compiled = mx.compile(original_call)
                dec.__call__ = compiled
                print("compile_installed", flush=True)
                crows = []
                for i in range(1, 6):
                    r = one_decode(codes_np, f"compiled{i}")
                    if r:
                        crows.append(r)
                print("COMPILE_SUMMARY", json.dumps(crows, ensure_ascii=False, indent=2), flush=True)
                dec.__call__ = original_call
            else:
                print("no mx.compile", flush=True)
        except Exception:
            print("compile_err", traceback.format_exc(), flush=True)

    print("SUMMARY", json.dumps({"mode": MODE, "rows": rows}, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
