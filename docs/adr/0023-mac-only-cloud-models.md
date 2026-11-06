# ADR 0023 — Mac-only hosting, all models on NEAR AI, a "smart" seat, Levanto Sage 2

Status: accepted (6 Nov 2026)

## Context
Both Sparks have been offline since ~3 Nov (the owner is building a power reserve for them). The Mac standby
(ADR 0020) took over, but after a Mac restart on 5 Nov Docker Desktop did not start and nearchant.com was down for
about a day. NEAR AI also retired `levanto/sage-1.4` (now `levanto/sage-2`), so caption checks were failing. The
owner wants the whole product on the Mac + NEAR AI Cloud for the rest of the hackathon, and a stronger model where
judgment matters more than speed.

## Decision
- **Hosting**: the Mac serves nearchant.com (`deploy/standby`, role `primary`), set up by
  `deploy/standby/mac-only.sh`. It needs neither the Spark nor SSH to it. It also adds the admin panel
  (`127.0.0.1:8790`) and the English voice service (Kokoro + faster-whisper on CPU), so videos work again.
- **Self-healing**: while `primary`, the watchdog checks the local gateway every 15 s. If it does not answer, the
  watchdog opens Docker Desktop, waits for it, and runs `compose up` (at most every 2 min, with a notification on
  failure). A launchd `caffeinate -s` keeps the Mac awake on power. The watchdog makes a daily database dump to
  `~/nearchant-standby/backups` (7 kept), because the Mac is now the only copy.
- **Models** (`providers.cloud.yaml`, all on NEAR AI Cloud):
  - main seat: Qwen3.6-35B-A3B (TEE), for vision, analysis, search and the store assistant;
  - second seat: Qwen3.8-27B (TEE), for posts, video scripts and caption edits;
  - **smart seat (new)**: Kimi K2.6 (TEE, attested by NEAR AI as "attested 3p"), for the moderator and the insight
    writer. These are background jobs where a wrong call costs a seller (a false removal paused a store on 2 Nov).
    It takes ~9–13 s and ~$0.0007 per moderation call. If its model is not served (Spark profiles, replay), the
    role falls back to the main seat.
  - decisions: **Levanto Sage 2**, with the same `/v1/systemone` API. It still has no attestation report, so it
    gets public data only (captions, store pages).
- Sage is a *decision* model (calibrated yes/no/score), not a writer. "Higher intelligence" for text therefore
  comes from the smart seat, and Sage stays the judge for checkable yes/no questions.
- Adapter: "no thinking" is sent as both `enable_thinking: false` (Qwen/GLM) and `thinking: false` (Kimi).

## Consequences
- All AI spend is NEAR AI credit, so keep the balance topped up. A credit error stops the job.
- Seat models are part of the replay key: roles used by `make demo` (profiler, opportunity-analyst, idea-writer,
  …) stay on their seats unless the demo is re-recorded. The moderator and insight writer are not in the demo.
- Going back to the Sparks later is `make failback` (ADR 0020). The fence stays: a returning Spark is stopped
  while the Mac is primary.
- The Mac must stay on power with the lid open (or an external display) until judging ends: hosted demos should
  stay up until at least 18 Nov, ideally 25 Nov.

## Addendum (6 Nov, evening): NVIDIA's verdict on the GPU, and two more report layouts
- With `NVIDIA_API_KEY` (Keychain), our check also asks **NVIDIA NRAS** about each model's GPU evidence. The request
  is the same as NVIDIA's `nv_attestation_sdk` (`POST /v3/attest/gpu`). Its ES384 JWTs are verified against NRAS's
  JWKS, and the overall result and our nonce must match. NVIDIA's "no" fails the check. "Could not ask" (`null`)
  leaves the result to the other checks. The signed token is published in the `.check.json` (`gpu_token`).
- NRAS refuses the owner's network (HTML 403 at its load balancer, even for its public JWKS), so `NRAS_URL` can point
  at a relay in the owner's Cloudflare account (`deploy/nras-relay`). Until then the GPU part reads "NRAS 403".
- Reports now come in three layouts, all checked: NEAR AI's own (ed25519 key ‖ nonce), NEAR AI with ECDSA (20-byte
  address zero-padded ‖ nonce), and attested third parties (Kimi K2.6 via Chutes: REPORTDATA[0..32] =
  sha256(nonce ‖ e2e_pubkey), the same value as every GPU's SPDM requester nonce). Two published Kimi checks that read
  "not ok" were re-run and now pass. Neither was linked to a post proof.

## Addendum 2 (6 Nov, night): NEAR AI's full verification checklist; speed
- Audited against docs.near.ai/cloud/verification. Added: **MRCONFIGID = 01 ‖ sha256(app_compose) ‖ zeros** (computed,
  not the API's `compose_hash`), **event log replayed to RTMR3**, **debug TDs rejected**, for the gateway and NEAR AI's
  models; and **response signatures**: after every NEAR AI chat call the router fetches `/v1/signature/{id}`
  (ed25519) and verifies it against the exact request/response bytes and the keys of the report pinned before the
  data went out (`responseSignature` in the envelope; schema first). Posts record it and "Verify a post" shows it.
  Kimi K2.6 (Chutes) gets only a `gateway` signature, which is labelled as the weaker kind.
- Attestation reports are now requested with `signing_algo=ed25519` and `x-no-aliasing: true` (same algorithm as
  the signatures).
- Speed: NEAR AI streams ~40–80 tokens/s, and thinking was 2–6K tokens per step. The nearai endpoint now turns
  thinking off like the Sparks did, and only the opportunity analyst thinks (`reasoning: true`). Photos → live posts
  went from 836 s to 146 s. GLM 5.3 Flash was tried and dropped: it was slower per token and ignored the
  no-thinking flag.
