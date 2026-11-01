# Image engine

`service/` is a copy of `inference_system/services/image` (the owner's Boost Content inference stack,
revision ): an OpenAI-compatible `/v1/images/generations` + `/v1/images/edits` over a headless
ComfyUI running Qwen-Image-Edit-2511 (Apache-2.0, Lightning 4-step fp8). Same owner; reused with permission.
Do not edit it here without porting the change back.

`comfy.Dockerfile` builds ComfyUI on top of `vllm-node:latest`, the local image that already has PyTorch
2.11 for the GB10 GPU (CUDA 13, sm_121) — so it builds only on `gx10-8695`. Weights live outside the repo
in `~/nearchant-node/comfy/models` (checksums: inference_system `knowledge/workflows/weights.lock`).
