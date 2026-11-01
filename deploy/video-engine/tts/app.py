"""English voiceover service: Kokoro-82M (kokoro-onnx, CPU) + voice polish + faster-whisper word timestamps.

Cut-down copy of advertisment_system `inference/adapters/gen-tts/app.py` (see ../NOTICE.md): same `/generate`
and `/transcribe` contract, English only — the uk/ru engine registry, normalization and verbalizer are dropped.
`polish.py` is copied unchanged; here it runs on the Kokoro output too (default preset TTS_POLISH=natural,
"off" = raw).

When API_KEY is set every call except /health needs `Authorization: Bearer $API_KEY`.

Env: KOKORO_ONNX, KOKORO_VOICES, WHISPER_MODEL_DIR, ASSETS_DIR, TTS_VOICE (default am_michael), TTS_POLISH,
API_KEY, HOST_NAME.
"""

import asyncio
import hmac
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Literal

import soundfile as sf
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

import polish as polish_mod

KOKORO_ONNX = os.environ.get("KOKORO_ONNX", "/weights/kokoro/kokoro-v1.0.onnx")
KOKORO_VOICES = os.environ.get("KOKORO_VOICES", "/weights/kokoro/voices-v1.0.bin")
WHISPER_DIR = os.environ.get("WHISPER_MODEL_DIR", "/weights/whisper/base.en")
ASSETS_DIR = Path(os.environ.get("ASSETS_DIR", "/data/assets"))
DEFAULT_VOICE = os.environ.get("TTS_VOICE", "am_michael")  # deep, professional American male
HOST_NAME = os.environ.get("HOST_NAME", "")
API_KEY = os.environ.get("API_KEY", "")
MODEL = "kokoro-82m"
LANG_MAP = {"en": "en-us", "en-us": "en-us", "en-gb": "en-gb"}
MAX_CHARS = 4000

app = FastAPI(title="nearchant-tts")

_k = None
_k_lock = threading.Lock()  # synthesis runs in worker threads — load the model once
_whisper = None
_whisper_lock = threading.Lock()


def _kok():
    global _k
    if _k is None:
        with _k_lock:
            if _k is None:
                from kokoro_onnx import Kokoro
                _k = Kokoro(KOKORO_ONNX, KOKORO_VOICES)
    return _k


def _whisper_model():
    global _whisper
    if _whisper is None:
        with _whisper_lock:
            if _whisper is None:
                from faster_whisper import WhisperModel
                _whisper = WhisperModel(WHISPER_DIR, device="cpu", compute_type="int8")
    return _whisper


@app.middleware("http")
async def _auth(request: Request, call_next):
    if API_KEY and request.url.path != "/health":
        given = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
        if not hmac.compare_digest(given.encode(), API_KEY.encode()):
            return JSONResponse({"detail": "bad api key"}, status_code=401)
    return await call_next(request)


class GenerateRequest(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_CHARS)
    lang: Literal["en", "en-us", "en-gb"] = "en"
    voice: str | None = None
    product_id: str = Field("adhoc", pattern=r"^[A-Za-z0-9_-]{1,64}$")
    speed: float = Field(1.0, ge=0.5, le=2.0)
    polish: str | None = None  # polish.PRESETS name; None = TTS_POLISH default, "off" = raw
    ambience: str | None = None
    ambience_level_db: float = -26.0


class TranscribeRequest(BaseModel):
    path: str  # relative to ASSETS_DIR
    lang: str = "en"
    word_timestamps: bool = True  # captions need per-word timing


@app.get("/health")
async def health():
    kokoro_ok = os.path.isfile(KOKORO_ONNX) and os.path.isfile(KOKORO_VOICES)
    base = {"ok": True, "model": MODEL, "engine": "kokoro", "host": HOST_NAME, "device": "cpu",
            "capabilities": {"kind": "tts", "langs": ["en"] if kokoro_ok else [], "clone": False,
                             "transcribe": os.path.isdir(WHISPER_DIR)},
            "default_voice": DEFAULT_VOICE, "polish_presets": list(polish_mod.PRESETS),
            "polish_default": polish_mod.DEFAULT_PRESET,
            "ambiences": [n for n in polish_mod.AMBIENCES if n != "none"]}
    try:
        voices = await asyncio.to_thread(lambda: _kok().get_voices())
        return {**base, "loaded": True, "voices": [v for v in voices if v.startswith(("am_", "bm_", "af_", "bf_"))]}
    except Exception as e:  # noqa: BLE001
        return {**base, "loaded": False, "error": f"{type(e).__name__}: {e}"}


@app.get("/files/{path:path}")
async def get_file(path: str):
    f = (ASSETS_DIR / path).resolve()
    if not f.is_relative_to(ASSETS_DIR.resolve()) or not f.is_file():
        raise HTTPException(404, "not found")
    return FileResponse(f)


def _voice(voice: str | None) -> str:
    """A Kokoro voice this build has; an unknown name degrades to DEFAULT_VOICE instead of a 502."""
    if voice and voice in _kok().get_voices():
        return voice
    return DEFAULT_VOICE


def _synth(req: GenerateRequest):
    voice = _voice(req.voice)
    samples, sr = _kok().create(req.text, voice=voice, speed=req.speed, lang=LANG_MAP[req.lang])
    samples = polish_mod.polish(samples, sr, req.polish)
    samples = polish_mod.ambience(samples, sr, req.ambience, req.ambience_level_db)
    return samples, sr, voice


@app.post("/generate")
async def generate(req: GenerateRequest):
    out_dir = ASSETS_DIR / req.product_id
    out_dir.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    try:
        samples, sr, voice = await asyncio.to_thread(_synth, req)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"tts synth failed: {type(e).__name__}: {e}")
    fn = f"vo-{int(time.time())}-{uuid.uuid4().hex[:6]}.wav"
    sf.write(str(out_dir / fn), samples, sr)
    return {
        "audio": {"path": f"{req.product_id}/{fn}", "sample_rate": int(sr),
                  "elapsed_s": round(time.time() - t0, 2), "duration_s": round(len(samples) / sr, 2)},
        "model": MODEL, "voice": voice, "text": req.text,
        "polish": req.polish or polish_mod.DEFAULT_PRESET, "ambience": req.ambience or None,
    }


@app.post("/transcribe")
async def transcribe(req: TranscribeRequest):
    """Transcribe one wav under ASSETS_DIR (faster-whisper, CPU int8). word_timestamps adds
    words: [{word, start, end}] for word-timed captions."""
    f = (ASSETS_DIR / req.path).resolve()
    if not f.is_relative_to(ASSETS_DIR.resolve()) or not f.is_file():
        raise HTTPException(404, "audio not found")
    if not os.path.isdir(WHISPER_DIR):
        raise HTTPException(503, f"whisper model missing ({WHISPER_DIR})")

    def _run():
        segments, info = _whisper_model().transcribe(
            str(f), language=req.lang, beam_size=1, vad_filter=False, word_timestamps=req.word_timestamps)
        parts, words = [], []
        for s in segments:
            parts.append(s.text.strip())
            for wd in (s.words or []) if req.word_timestamps else []:
                words.append({"word": wd.word.strip(), "start": round(wd.start, 3), "end": round(wd.end, 3)})
        return " ".join(parts).strip(), words, info

    t0 = time.time()
    try:
        text_out, words, info = await asyncio.to_thread(_run)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"transcribe failed: {type(e).__name__}: {e}")
    out = {"text": text_out, "language": info.language, "duration_s": round(info.duration, 2),
           "elapsed_s": round(time.time() - t0, 2)}
    if req.word_timestamps:
        out["words"] = words
    return out
