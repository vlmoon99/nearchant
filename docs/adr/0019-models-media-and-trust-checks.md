# 0019 — Two Sparks for the LLMs, Comfy Cloud for media, our own trust checks

**Context.** By 1 Nov the content store (ADR 0018) ran everything on one Spark and the Mac fallback. The owner set
priorities on 1–2 Nov: Nearchant first; gx10-8695 + gx10-c3c8 for Nearchant (the Gigabyte stays personal); pictures
and video only on Comfy Cloud. Live testing also showed (a) the edit model invents text (a "ZARA" tag) and offers
("50 % off"), (b) Wan 2.2 5B changes the product, (c) attestation reports were pinned but unchecked.

**Decision.**
- **LLMs, one model per Spark** (dual-Spark tensor parallel is fragile and ~1.3× faster at best): gx10-8695 runs
  Qwen3.6-35B-A3B (vision, analysis, opportunities, learning); gx10-c3c8 runs Qwen3.8-27B NVFP4 (posts, insights,
  video scripts, caption edits) as the content store's second seat, which degrades to the main seat if down.
- **Media on Comfy Cloud only**: Qwen-Image-Edit 2511 (product photos), Qwen-Image 2512 (no photo), Wan 2.2 I2V 14B
  Lightning (video, camera-only motion). The image service runs in Comfy Cloud mode; no local ComfyUI.
- **Text on media is ours** (advertisment_system TEXT_ON_MEDIA_PLAN): headline strips, hooks, captions, end-cards in
  our font and the brand colour; prompts forbid lettering and a vision check re-rolls once.
- **Checks before trust**: Levanto Sage (NEAR AI decision model) checks captions for invented offers — public data
  only, since Sage has no attestation report; the proof's review records it. NEAR AI TEE reports are checked by us
  (nonce, key and compose hash bound into the TDX quote; quote verified by Phala's DCAP verifier) and published
  next to the report; `/verify/<n>` recomputes a post's fingerprint from the published files.
- **Owner's own wallet**: NEP-413 signed message links a NEAR wallet and signs in; Withdraw signs in the browser
  with the store key. The server never holds a seller's full-access key.

**Consequences.** Comfy credits are a dependency (the owner's credits end 11 Nov; without them posts fall back to the
seller's photo). Writing is ~23 tok/s on Qwen3.8 (a 3-post batch ≈ 1–2 min). NVIDIA's NRAS needs an API key, so GPU
evidence is matched to our nonce but not checked by NVIDIA. Sage checks cost a few NEAR AI tokens per post.
