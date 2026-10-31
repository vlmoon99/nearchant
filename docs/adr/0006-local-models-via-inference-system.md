# 0006 — Local models through the owner's inference cluster

**Context.** The owner's GX10/Spark machines already run `inference_system`: LiteLLM on every node, a health-checked
balancer, a Postgres master/follower, Qwen3.6-35B-A3B and other models, failover proven between nodes. It also
serves another live product.

**Decision.** Nearchant does not run its own vLLM. The router treats the cluster gateway as one OpenAI-compatible
endpoint (`privacy_tier: local`) with its own project key, and NEAR AI Cloud (`privacy_tier: tee`) as the
fallback for every capability. Per-capability routing stays in `config/providers.yaml`.

**Consequences.** Nearchant never restarts or reconfigures the shared cluster; engine changes happen in that repo.
The `deploy/spark` recipes from the plan are not needed in M0.
