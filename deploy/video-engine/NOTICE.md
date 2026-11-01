# Video + English voiceover engine

Copied from the owner's `advertisment_system` (revision `331775c`); same owner, reused with permission.
Do not edit the source repo from here.

- `video/app.py` — cut down from `inference/adapters/gen-video/app.py`: the same `/generate` contract, LTX-2.5
  only (Wan, RIFE, vLLM sleep, keep-warm and `/system` removed), plus Bearer auth, a render lock and a timeout.
- `video/workflows/ltx25_{i2v,t2v}_api.json` — copied unchanged from `inference/workflows/`.
- `tts/app.py` — cut down from `inference/adapters/gen-tts/app.py`: English Kokoro-82M (`kokoro-onnx`, CPU) and
  `/transcribe` (faster-whisper `base.en`, CPU int8). The uk/ru engines, `engines.py`, `normalize.py` and
  `verbalize.py` are dropped; Bearer auth added; polish now runs on the Kokoro output.
- `tts/polish.py` — copied unchanged.

ComfyUI is the image-engine build (`../image-engine/comfy.Dockerfile`, `nearchant/comfy:dev`), moved to the
second Spark with `docker save | docker load`.

## Weights (outside the repo, on gx10-c3c8)

- LTX-2.5 (`Lightricks/LTX-2.5`, LTX-2.5 Community licence — free below $10M annual revenue): the five files
  already in `/home/server/ComfyUI/models/{diffusion_models,text_encoders,vae,latent_upscale_models}`, mounted
  read-only. Checksums: `advertisment_system/inference/workflows/weights.lock`.
- Kokoro-82M (Apache-2.0): `~/nearchant-video/weights/kokoro/{kokoro-v1.0.onnx,voices-v1.0.bin}` (copied).
- faster-whisper `Systran/faster-whisper-base.en` (MIT): `~/nearchant-video/weights/whisper/base.en`.

## Run

```
# on gx10-c3c8, with this folder at ~/nearchant-video/src/deploy/video-engine and VIDEO_API_KEY in .env
docker compose -p ncvideo up -d --build
```

Never touch the `inf-*`/`bc-*` containers or `~/Documents/dev/inference_system` on that machine.
