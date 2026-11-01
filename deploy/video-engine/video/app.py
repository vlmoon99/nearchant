"""Video service over a headless ComfyUI: LTX-2.5 22B distilled (int8), image-to-video or text-to-video,
native 24 fps with synchronized audio.

Cut-down copy of advertisment_system `inference/adapters/gen-video/app.py` (see ../NOTICE.md): same
`/generate` contract, LTX-2.5 only (the Wan/RIFE paths, vLLM sleep, keep-warm and /system are dropped —
this runs alone on its own Spark). Fills a placeholder-templated workflow (`workflows/ltx25_{i2v,t2v}_api.json`),
submits it to ComfyUI `/prompt`, polls `/history`, copies the MP4 into ASSETS_DIR and serves it at /files.

When API_KEY is set every call except /health needs `Authorization: Bearer $API_KEY`.

Env: COMFY_URL, COMFY_OUTPUT, COMFY_INPUT, ASSETS_DIR, WF_DIR, LTX_TEXT_ENCODER_DEVICE, RENDER_TIMEOUT_S,
API_KEY, HOST_NAME.
"""

import asyncio
import base64
import binascii
import hmac
import json
import os
import random
import shutil
import time
import uuid
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

COMFY_URL = os.environ.get("COMFY_URL", "http://comfy:8188").rstrip("/")
COMFY_OUT = Path(os.environ.get("COMFY_OUTPUT", "/comfy/output"))
COMFY_IN = Path(os.environ.get("COMFY_INPUT", "/comfy/input"))
ASSETS_DIR = Path(os.environ.get("ASSETS_DIR", "/data/assets"))
WF_DIR = Path(os.environ.get("WF_DIR", str(Path(__file__).parent / "workflows")))
HOST_NAME = os.environ.get("HOST_NAME", "")
# Where ComfyUI runs the LTX text encoder (Gemma-4-12B int8, ~15 GB). `cpu` costs 55–65 s per new prompt
# but keeps the GPU pool for the transformer; `default` = the GPU.
LTX_TEXT_ENCODER_DEVICE = os.environ.get("LTX_TEXT_ENCODER_DEVICE", "cpu")
RENDER_TIMEOUT_S = int(os.environ.get("RENDER_TIMEOUT_S", "1800"))
API_KEY = os.environ.get("API_KEY", "")
MODEL = "ltx-2.5-22b-distilled"
FPS = 24
MAX_IMAGE_BYTES = 25 * 1024 * 1024

app = FastAPI(title="nearchant-video")
_lock = asyncio.Lock()  # one render at a time: a second LTX graph would not fit beside the first


@app.middleware("http")
async def _auth(request: Request, call_next):
    if API_KEY and request.url.path != "/health":
        given = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
        if not hmac.compare_digest(given.encode(), API_KEY.encode()):
            return JSONResponse({"detail": "bad api key"}, status_code=401)
    return await call_next(request)


class GenerateRequest(BaseModel):
    prompt: str
    product_id: str = Field("adhoc", pattern=r"^[A-Za-z0-9_-]{1,64}$")
    ref_image_path: str | None = None  # relative to ASSETS_DIR -> image-to-video
    ref_image_b64: str | None = None   # the same image as bytes, for a caller on another machine; wins
    quality: str = "draft"
    width: int = Field(704, ge=64, le=1920, multiple_of=64)
    height: int = Field(1280, ge=64, le=1920, multiple_of=64)
    num_frames: int = Field(121, ge=9, le=257)  # 8k+1; 121 = 5 s at 24 fps
    seed: int | None = None
    model: str | None = None  # only "ltx2" is served; kept for contract compatibility


def _wf_file(is_i2v: bool) -> Path:
    return WF_DIR / f"ltx25_{'i2v' if is_i2v else 't2v'}_api.json"


def build_workflow(req: GenerateRequest, hero: str | None) -> dict:
    """Substitute the __TOKENS__ of the LTX-2.5 template (converted from ComfyUI's official subgraph):
    renders at half-res, latent-upscales 2x, refines, decodes video and audio in one pass."""
    subs = {
        "__PROMPT__": req.prompt or "",
        "__WIDTH__": req.width,
        "__HEIGHT__": req.height,
        "__WIDTH_HALF__": req.width // 2,
        "__HEIGHT_HALF__": req.height // 2,
        "__FRAMES__": req.num_frames,
        "__FRAME_RATE__": FPS,
        "__SEED__": req.seed if req.seed is not None else random.randint(0, 2**31 - 1),
        "__IMAGE__": hero or "",
        "__PREFIX__": f"ncltx_{req.product_id[:8]}",
    }
    wf = json.loads(_wf_file(bool(hero)).read_text())
    for node in wf.values():
        ins = node.get("inputs", {})
        for k, v in ins.items():
            if isinstance(v, str) and v in subs:
                ins[k] = subs[v]
        if node.get("class_type") == "CLIPLoader":
            ins["device"] = LTX_TEXT_ENCODER_DEVICE
    return wf


def _stage_image(rel: str | None, b64: str | None) -> str:
    COMFY_IN.mkdir(parents=True, exist_ok=True)
    if b64:
        try:
            data = base64.b64decode(b64, validate=True)
        except (binascii.Error, ValueError):
            raise HTTPException(422, "ref_image_b64 is not valid base64")
        if len(data) > MAX_IMAGE_BYTES:
            raise HTTPException(413, "ref image too large")
        name = f"nchero-{uuid.uuid4().hex[:8]}{Path(rel or '').suffix or '.png'}"
        (COMFY_IN / name).write_bytes(data)
        return name
    src = (ASSETS_DIR / (rel or "")).resolve()
    if not src.is_relative_to(ASSETS_DIR.resolve()) or not src.is_file():
        raise HTTPException(404, f"ref image not found: {rel} (a remote caller must send ref_image_b64)")
    name = f"nchero-{uuid.uuid4().hex[:8]}{src.suffix or '.png'}"
    shutil.copy(src, COMFY_IN / name)
    return name


@app.get("/health")
async def health():
    try:
        async with httpx.AsyncClient(timeout=4) as c:
            ok = (await c.get(f"{COMFY_URL}/system_stats")).status_code == 200
    except httpx.HTTPError:
        ok = False
    return {
        "ok": True, "loaded": ok, "model": MODEL, "host": HOST_NAME, "engine": "comfy", "busy": _lock.locked(),
        "capabilities": {"kind": "video", "models": ["ltx2"] if ok else [], "audio": True, "i2v": True,
                         "max_frames": 121, "fps": FPS},
    }


@app.get("/files/{path:path}")
async def get_file(path: str):
    f = (ASSETS_DIR / path).resolve()
    if not f.is_relative_to(ASSETS_DIR.resolve()) or not f.is_file():
        raise HTTPException(404, "not found")
    return FileResponse(f)


async def _post_with_retry(c: httpx.AsyncClient, url: str, body: dict, tries: int = 3) -> httpx.Response:
    for i in range(tries):
        try:
            return await c.post(url, json=body)
        except httpx.TransportError:
            if i == tries - 1:
                raise
            await asyncio.sleep(2 ** i)
    raise AssertionError("unreachable")


async def _render(wf: dict) -> dict:
    async with httpx.AsyncClient(timeout=60) as c:
        try:
            r = await _post_with_retry(c, f"{COMFY_URL}/prompt", {"prompt": wf, "client_id": "nearchant-video"})
        except httpx.HTTPError as e:
            raise HTTPException(503, f"ComfyUI unreachable: {e}")
        if r.status_code != 200:
            raise HTTPException(502, f"ComfyUI rejected workflow: {r.text[:300]}")
        pid = r.json()["prompt_id"]
        deadline = time.monotonic() + RENDER_TIMEOUT_S
        while time.monotonic() < deadline:
            await asyncio.sleep(2)
            try:
                entry = (await c.get(f"{COMFY_URL}/history/{pid}")).json().get(pid)
            except (httpx.HTTPError, ValueError):
                continue
            if not entry:
                continue
            if entry.get("status", {}).get("status_str") == "error":
                raise HTTPException(502, f"ComfyUI error: {entry['status'].get('messages', [])[-2:]}")
            for o in entry.get("outputs", {}).values():
                vids = o.get("images") or o.get("videos") or o.get("gifs") or []
                if vids:
                    return vids[0]
        try:
            await c.post(f"{COMFY_URL}/interrupt")
        except httpx.HTTPError:
            pass
    raise HTTPException(504, "ComfyUI generation timed out")


@app.post("/generate")
async def generate(req: GenerateRequest):
    if req.model not in (None, "ltx2"):
        raise HTTPException(422, f"model {req.model!r} is not served by this host (serves ['ltx2'])")
    hero = _stage_image(req.ref_image_path, req.ref_image_b64) if (req.ref_image_path or req.ref_image_b64) else None
    wf = build_workflow(req, hero)
    out_dir = ASSETS_DIR / req.product_id
    out_dir.mkdir(parents=True, exist_ok=True)
    async with _lock:
        t0 = time.time()
        vid = await _render(wf)
        elapsed = round(time.time() - t0, 1)
    src = COMFY_OUT / vid.get("subfolder", "") / vid["filename"]
    fn = f"video-{int(time.time())}-{uuid.uuid4().hex[:6]}.mp4"
    shutil.copy(src, out_dir / fn)
    return {"video": {"path": f"{req.product_id}/{fn}", "elapsed_s": elapsed, "quality": req.quality,
                      "frames": req.num_frames, "fps": FPS, "width": req.width, "height": req.height,
                      "model": MODEL}}
