# 0013 — Replay provider for judges

**Context.** Automated judges clone the repo and follow the README; they have no GPU and probably no NEAR AI key.

**Decision.** A `replay` adapter answers capability calls from recorded envelopes (keyed by request hash) and is
used by the `demo` profile when `NEARAI_API_KEY` is not set. Recordings are made from real runs and committed.

**Consequences.** `make demo` runs the whole loop with Docker only. It doubles as a deterministic test fixture.
