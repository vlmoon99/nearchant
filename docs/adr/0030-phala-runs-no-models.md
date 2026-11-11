# 0030 — The Phala server runs no models; videos off until a voice model is hosted

**Context.** The judged deployment moves to a Phala Cloud CVM (ADR 0007), a CPU-only TDX machine with 2 cores. The
compose in `deploy/phala` still ran the Kokoro voice and faster-whisper (ONNX/CTranslate2 on CPU) for the post
videos. On 2 cores that is slow, and the owner wants every model call to go to a hosted model: NEAR AI Cloud TEE
for text, vision, embeddings and speech-to-text, Comfy Cloud for pictures. On 11 Nov neither NEAR AI Cloud nor
Phala's own model API (RedPill) offers text-to-speech.

**Decision.**
- The Phala compose has no `tts` service and no `TTS_URL`. The CVM runs the gateway, worker, Postgres, the image
  service (a client for Comfy Cloud, no model), SearXNG and the Marp renderer: no model weights.
- Without `TTS_URL` the worker makes no videos and the post page says "Videos are not available on this server yet"
  in place of the "Make a video" button (`UiConfig.videos`).
- Phala's model API (RedPill, key in the Keychain as `REDPILL_API_KEY`) is not in the routing yet: as a TEE fallback
  it needs its own attestation check first.

**Consequences.** No short videos on the judged site; pictures and posts are unchanged. Videos come back when a
hosted voice model exists (NEAR AI, RedPill, or a Comfy Cloud voice workflow): set `TTS_URL` to it. The Mac stack
keeps its local voice service.
