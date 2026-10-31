# 0017 — The council's second model family must be TEE-attested

**Context.** The council and reviewer use a second model family so one model doesn't grade itself (docs/swarm.md).
On NEAR AI Cloud (checked 2026-11-01), `deepseek/deepseek-v4.1-flash` and `moonshotai/kimi-k3` return 503 from
`/v1/attestation/report`; GLM-5.3, GLM-5.3-flash, Qwen and FLUX return a report. Buyer briefs are private data.

**Decision.** The second seat is `z-ai/glm-5.3-flash` (attested). The router refuses private data to any model
whose attestation fails, caches that per model for 10 minutes, and does not count it against the endpoint's circuit
breaker. If the second seat is unreachable, a role falls back to the main seat and the job log says so.

**Consequences.** GLM-5.3-flash is slower (~30 tokens/s on NEAR AI), so critique outputs are capped (≤8 items,
short fields). Faster second families can be added once NEAR AI attests them.
