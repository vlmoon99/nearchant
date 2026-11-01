# Video posts + English voiceover (stretch 13b) — reuse plan

Source: the owner's `advertisment_system` (mapped 2026-11-01). English only (Kokoro); no uk/ru TTS.

## What it makes
A vertical "product short": one LTX-2.5 image-to-video clip from the product photo (704×1280, 121 frames = 5 s at
24 fps), looped under a 10–20 s English voiceover, with a hook overlay, word-timed captions, optional music bed
and end-card. (Talking avatar via InfiniteTalk exists but renders ~2 min per second of video — not a default.)

## Pieces to copy (as with the image engine: copy, never change the source repo)
- **Video adapter** `inference/adapters/gen-video/app.py` (:8104) + workflow `inference/workflows/ltx25_i2v_api.json`
  (placeholders `__PROMPT__ __WIDTH__ __HEIGHT__ __FRAMES__ __SEED__ __IMAGE__ …`); imports `sysinfo.py`,
  `keepwarm.py`. Submits to ComfyUI `/prompt`, polls `/history`, sleeps vLLM during the render (`VLLM_SLEEP_URL`).
- **Weights**: 5 LTX-2.5 files from `Lightricks/LTX-2.5` (gated on Hugging Face — needs the owner's HF token and
  licence acceptance), ~40 GB, checksums in `inference/workflows/weights.lock`. Text encoder Gemma-4-12B on CPU.
- **TTS adapter** `inference/adapters/gen-tts/app.py` (:8105) cut to Kokoro-82M (`kokoro-onnx`, CPU) + `polish.py`
  + `/transcribe` (faster-whisper word timestamps). Drop `engines.py`, `normalize.py`, `verbalize.py`.
- **Logic to port to TypeScript**: the "short-form video ad director" script prompt (`backend/ads/pipelines/short.py`
  ~L230–262 → `{hook, voiceover, video_prompt, caption, hashtags}`), photo cover-crop to 704×1280, caption chunking
  (`subtitles.py`: ≤3 words / 18 chars), the `_compose` ffmpeg filtergraph (loop, grade, overlays, ducked music,
  loudnorm, libx264 crf 23, AAC 192k). Use a system ffmpeg with libass to burn ASS subtitles instead of PNGs.
- **Assets**: Montserrat fonts (`data/fonts`), a licensed music track.

## Resources and timing (GB10, 128 GB unified)
Warm short ~105 s (96 GB peak); cold ~200 s (108 GB); Gemma prompt encoding 55–65 s on CPU. Cannot co-reside with
our LLM + image engine on `gx10-8695`: either run on the second Spark (`gx10-c3c8`, owner's decision) or evict the
image engine (`/free`) and sleep vLLM for each render.

## Licence
LTX-2.5 Community: free below $10M annual revenue. Kokoro-82M: Apache-2.0.
