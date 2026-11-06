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
