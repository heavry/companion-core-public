#!/usr/bin/env python3
"""Voicebox-compatible MLX backend with A1 clear_cache policy.

Does NOT modify /Applications/Voicebox.app.
A1: skip periodic clear_cache every 50 AR steps; allow light cleanup at end.
API: GET /health, POST /generate, GET /history/{id}
Port default: 17494
"""
from __future__ import annotations

import json
import os
import queue
import sqlite3
import threading
import time
import uuid
import wave
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

PORT = int(os.environ.get("VB_A1_PORT", "17494"))
APP = Path.home() / "Library/Application Support/sh.voicebox.app"
GEN_DIR = APP / "generations"
GEN_DIR.mkdir(parents=True, exist_ok=True)
MODEL_ID = "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16"
PROFILE_ID = os.environ.get("VB_A1_PROFILE_ID", "0763cc16-4523-4b65-90d0-823a0dfd8e5f")
MAX_TOKENS = int(os.environ.get("VB_A1_MAX_TOKENS", "128"))
A1_SKIP_PERIODIC_CLEAR = os.environ.get("VB_A1_SKIP_PERIODIC_CLEAR", "1") == "1"

import numpy as np
import mlx.core as mx
import soundfile as sf

_model = None
_ref_wave = None
_ref_text = ""
_ref_path = ""
_ready = False
_load_error = None
_jobs: dict[str, dict] = {}
_job_lock = threading.Lock()
_gen_q: queue.Queue = queue.Queue()
_stats = {"generations": 0, "last_wall_s": None, "last_audio_s": None}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_ref():
    global _ref_wave, _ref_text, _ref_path
    db = sqlite3.connect(str(APP / "voicebox.db"))
    try:
        row = db.execute(
            "SELECT audio_path, reference_text FROM profile_samples WHERE profile_id=? LIMIT 1",
            (PROFILE_ID,),
        ).fetchone()
    finally:
        db.close()
    if not row:
        raise RuntimeError(f"no profile_sample for {PROFILE_ID}")
    _ref_path = str(APP / row[0])
    _ref_text = row[1]
    data, _sr = sf.read(_ref_path, dtype="float32")
    if data.ndim > 1:
        data = data.mean(axis=1)
    _ref_wave = mx.array(data)


def ensure_model():
    """Must be called on the MLX generation thread."""
    global _model, _ready, _load_error
    if _ready:
        return
    if _load_error:
        raise RuntimeError(_load_error)
    try:
        load_ref()
        from mlx_audio.tts import load_model

        _model = load_model(MODEL_ID)
        if A1_SKIP_PERIODIC_CLEAR:
            mx.clear_cache = lambda *a, **k: None
            import mlx.core as _m

            _m.clear_cache = mx.clear_cache
        _ready = True
        _load_error = None
        print(f"[a1] model ready device={mx.default_device()} ref={_ref_path}", flush=True)
    except Exception as e:
        _load_error = str(e)
        raise


def end_clear():
    try:
        mx.eval(mx.array([0.0]))
    except Exception:
        pass


def wav_write(path: Path, audio, sample_rate: int):
    arr = np.asarray(audio)
    if arr.dtype != np.float32:
        arr = arr.astype(np.float32)
    if arr.ndim > 1:
        arr = arr.mean(axis=0)
    peak = float(np.max(np.abs(arr)) or 1.0)
    if peak > 1.0:
        arr = arr / peak
    pcm = (arr * 32767.0).astype(np.int16)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sample_rate))
        w.writeframes(pcm.tobytes())


def generate_sync(text: str) -> dict:
    ensure_model()
    t0 = time.time()
    audio = None
    sample_rate = getattr(_model, "sample_rate", 24000)
    token_count = None
    out = _model.generate(
        text=text,
        ref_audio=_ref_wave,
        ref_text=_ref_text,
        language="zh",
        max_tokens=MAX_TOKENS,
    )
    if hasattr(out, "__iter__") and not isinstance(out, (bytes, str, np.ndarray)):
        for item in out:
            if hasattr(item, "audio"):
                audio = item.audio
                sample_rate = getattr(item, "sample_rate", sample_rate)
                token_count = getattr(item, "token_count", None)
            elif isinstance(item, tuple) and len(item) >= 2:
                audio, sample_rate = item[0], item[1]
    elif isinstance(out, tuple):
        audio, sample_rate = out[0], out[1]
    else:
        audio = out
    wall = time.time() - t0
    if audio is None:
        raise RuntimeError("no audio produced")
    arr = np.asarray(audio)
    audio_s = float(arr.shape[-1] / float(sample_rate)) if arr.ndim else 0.0
    gen_id = str(uuid.uuid4())
    wav = GEN_DIR / f"{gen_id}.wav"
    wav_write(wav, audio, int(sample_rate))
    end_clear()
    _stats["generations"] += 1
    _stats["last_wall_s"] = round(wall, 3)
    _stats["last_audio_s"] = round(audio_s, 3)
    print(
        f"[a1] gen wall={wall:.2f}s audio={audio_s:.2f}s tokens={token_count} peak_mb={mx.get_peak_memory()/1e6:.0f}",
        flush=True,
    )
    return {
        "id": gen_id,
        "audio_path": f"generations/{gen_id}.wav",
        "duration": audio_s,
        "wall_s": round(wall, 3),
        "token_count": token_count,
        "sample_rate": int(sample_rate),
    }


def worker():
    # Single thread owns MLX GPU stream: load + generate here only.
    try:
        ensure_model()
    except Exception as e:
        print(f"[a1] worker preload failed: {e}", flush=True)
    while True:
        job_id = _gen_q.get()
        if job_id is None:
            break
        with _job_lock:
            job = _jobs.get(job_id)
            if not job:
                _gen_q.task_done()
                continue
            job["status"] = "generating"
        try:
            ensure_model()
            result = generate_sync(job["text"])
            with _job_lock:
                job.update(
                    status="completed",
                    audio_path=result["audio_path"],
                    duration=result["duration"],
                    error=None,
                    wall_s=result["wall_s"],
                    token_count=result.get("token_count"),
                )
        except Exception as e:
            with _job_lock:
                job.update(status="failed", error=str(e)[:500])
            print(f"[a1] gen failed: {e}", flush=True)
        finally:
            _gen_q.task_done()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[a1-http] {self.address_string()} {fmt % args}", flush=True)

    def _json(self, code: int, obj: dict):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            self._json(
                200,
                {
                    "status": "healthy",
                    "model_loaded": bool(_ready),
                    "model_downloaded": True,
                    "model_size": "1.7B",
                    "gpu_available": True,
                    "gpu_type": "MPS (Apple Silicon)",
                    "vram_used_mb": round(mx.get_active_memory() / 1e6, 1) if _ready else None,
                    "backend_type": "mlx",
                    "backend_variant": "a1_no_periodic_clear",
                    "gpu_compatibility_warning": None,
                    "generations": _stats["generations"],
                    "last_wall_s": _stats["last_wall_s"],
                    "device": str(mx.default_device()),
                    "profile_id": PROFILE_ID,
                },
            )
            return
        if path.startswith("/history/"):
            gid = path.split("/", 2)[-1]
            with _job_lock:
                job = _jobs.get(gid)
            if not job:
                self._json(404, {"detail": "not found"})
                return
            self._json(
                200,
                {
                    "id": job["id"],
                    "profile_id": PROFILE_ID,
                    "text": job["text"],
                    "language": job.get("language", "zh"),
                    "audio_path": job.get("audio_path"),
                    "duration": job.get("duration"),
                    "engine": "qwen",
                    "model_size": "1.7B",
                    "status": job.get("status"),
                    "error": job.get("error"),
                    "created_at": job.get("created_at"),
                },
            )
            return
        self._json(404, {"detail": "not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        if path != "/generate":
            self._json(404, {"detail": "not found"})
            return
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw or b"{}")
        except Exception:
            self._json(422, {"detail": "invalid json"})
            return
        text = str(body.get("text") or "").strip()
        if not text:
            self._json(422, {"detail": "text required"})
            return
        gid = str(uuid.uuid4())
        job = {
            "id": gid,
            "text": text,
            "language": body.get("language") or "zh",
            "status": "generating",
            "audio_path": None,
            "duration": None,
            "error": None,
            "created_at": utc_now(),
        }
        with _job_lock:
            _jobs[gid] = job
        _gen_q.put(gid)
        self._json(
            200,
            {
                "id": gid,
                "profile_id": PROFILE_ID,
                "text": text,
                "language": job["language"],
                "audio_path": None,
                "duration": None,
                "engine": "qwen",
                "model_size": "1.7B",
                "status": "generating",
                "error": None,
                "created_at": job["created_at"],
            },
        )


def main():
    print(f"[a1] starting port={PORT} a1_skip_periodic_clear={A1_SKIP_PERIODIC_CLEAR}", flush=True)
    threading.Thread(target=worker, name="a1-mlx-gen", daemon=True).start()
    httpd = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[a1] listening on 127.0.0.1:{PORT}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
