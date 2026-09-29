#!/usr/bin/env python3
"""Fixed-prefix KV truth + short/long generation bench for Qwen3 ICL."""
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
SHORT = "宝宝我回来啦。"
LONG = "这是 Voicebox 推理分段测试。"


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


def clone_cache(cache):
    out = []
    for c in cache:
        nc = type(c)()
        nc.keys = mx.array(c.keys) if c.keys is not None else None
        nc.values = mx.array(c.values) if c.values is not None else None
        nc.offset = int(c.offset)
        out.append(nc)
    return out


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "all"
    print(f"DEVICE={mx.default_device()}", flush=True)
    ref_wave, ref_text = load_ref()
    from mlx_audio.tts import load_model

    t0 = time.time()
    model = load_model(MODEL_ID)
    print(f"LOAD {time.time()-t0:.2f}s", flush=True)
    mx.clear_cache = lambda *a, **k: None
    import mlx.core as _m

    _m.clear_cache = mx.clear_cache

    def prepare(text):
        t = time.time()
        ie, thr, pad, codes = model._prepare_icl_generation_inputs(
            text=text, ref_audio=ref_wave, ref_text=ref_text, language="zh"
        )
        mx.eval(ie, thr, pad, codes)
        return ie, thr, pad, codes, time.time() - t

    def prefill(ie):
        cache = model.talker.make_cache()
        t = time.time()
        lg, h = model.talker(ie, cache=cache)
        mx.eval(lg, h)
        for layer in cache:
            if layer.keys is not None:
                mx.eval(layer.keys)
            if layer.values is not None:
                mx.eval(layer.values)
        return cache, lg, time.time() - t, cache[0].offset

    results = {"boundary": None, "kv": None, "gens": [], "decode": None}

    if mode in ("all", "boundary", "kv"):
        ie_a, _, _, codes, _ = prepare(SHORT)
        ie_b, _, _, _, _ = prepare("你今天是不是有点累呀？")
        ie_c, _, _, _, _ = prepare("那个测试跑完了吗？")
        a, b, c = [np.asarray(x) for x in (ie_a, ie_b, ie_c)]
        minlen = min(a.shape[1], b.shape[1], c.shape[1])
        lcp = 0
        for i in range(minlen):
            if np.allclose(a[0, i], b[0, i], atol=1e-5) and np.allclose(a[0, i], c[0, i], atol=1e-5):
                lcp += 1
            else:
                break
        results["boundary"] = {
            "seq_lens": [a.shape[1], b.shape[1], c.shape[1]],
            "common_prefix_len": lcp,
            "ref_codes": list(codes.shape),
            "note": "positions >= common_prefix_len depend on target text (codec overlay)",
        }
        print("BOUNDARY", json.dumps(results["boundary"]), flush=True)

        # KV correctness/offsets for 51-prefix + 1-token
        L = results["boundary"]["common_prefix_len"]
        fixed = ie_a[:, :L]
        c0, lg0, tp, off0 = prefill(fixed)
        pc = clone_cache(c0)
        one = ie_a[:, L : L + 1]
        c1 = clone_cache(pc)
        t1 = time.time()
        lg1, h1 = model.talker(one, cache=c1)
        mx.eval(lg1, h1)
        dt1 = time.time() - t1
        # multi-token should fail
        multi_ok = True
        try:
            c2 = clone_cache(pc)
            model.talker(ie_a[:, L : L + 8], cache=c2)
            mx.eval()
        except Exception as e:
            multi_ok = False
            multi_err = str(e)[:120]
        else:
            multi_err = "unexpected_ok"
        results["kv"] = {
            "prefix_eval_s": round(tp, 3),
            "prefix_offset": off0,
            "prefix_keys_shape": list(c0[0].keys.shape) if c0[0].keys is not None else None,
            "one_tok_s": round(dt1, 3),
            "one_tok_offset": c1[0].offset,
            "multi_tok_append_works": multi_ok,
            "multi_tok_error": None if multi_ok else multi_err,
            "clone_peak_mb": round(mx.get_peak_memory() / 1e6, 1),
        }
        print("KV", json.dumps(results["kv"]), flush=True)

    if mode in ("all", "gens"):
        # warmup one short full generate
        def full_gen(text, label):
            mx.reset_peak_memory()
            t0 = time.time()
            ie, thr, pad, codes, tp = prepare(text)
            cache, lg, tpf, off = prefill(ie)
            # note: this is only prefill, not full AR+decode; use model.generate for wall
            row = {
                "label": label,
                "text": text[:20],
                "prepare_s": round(tp, 3),
                "prefill_s": round(tpf, 3),
                "prefill_total_s": round(tp + tpf, 3),
                "seq_len": int(ie.shape[1]),
                "offset": off,
                "peak_mb": round(mx.get_peak_memory() / 1e6, 1),
            }
            print("PREFILL", json.dumps(row, ensure_ascii=False), flush=True)
            return row

        # Full generation via model.generate for real wall
        def gen_wall(text, label):
            mx.reset_peak_memory()
            t0 = time.time()
            n_tok = None
            audio = None
            try:
                out = model.generate(
                    text=text, ref_audio=ref_wave, ref_text=ref_text, language="zh", max_tokens=128
                )
                for item in out:
                    if hasattr(item, "audio"):
                        audio = item.audio
                        n_tok = getattr(item, "token_count", None)
            except Exception:
                print("GEN_ERR", label, traceback.format_exc(), flush=True)
                return None
            wall = time.time() - t0
            audio_s = None
            if audio is not None:
                audio_s = float(np.asarray(audio).shape[-1] / float(getattr(model, "sample_rate", 24000)))
            row = {
                "label": label,
                "wall_s": round(wall, 3),
                "audio_sec": round(audio_s, 3) if audio_s else None,
                "tokens": n_tok,
                "rtf": round(wall / audio_s, 2) if audio_s else None,
                "peak_mb": round(mx.get_peak_memory() / 1e6, 1),
            }
            print("GEN", json.dumps(row, ensure_ascii=False), flush=True)
            results["gens"].append(row)
            return row

        # warmup
        gen_wall(SHORT, "warmup")
        for i in range(3):
            gen_wall(SHORT, f"short_{i+1}")
        for i in range(2):
            gen_wall(LONG, f"long_{i+1}")

    print("SUMMARY", json.dumps(results, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
