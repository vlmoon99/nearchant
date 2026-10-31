# 0002 — Drop the Shade Agent Framework

**Context.** `architecture.md` §14 named Shade Agents as the NEAR-native choice for TEE agents. NEAR's docs now mark
it **deprecated**; standalone maintenance ended around 2026-04-19.

**Decision.** Don't use it. Private inference relies on NEAR AI Cloud TEE attestation
(`/v1/attestation/report`, carried in the result envelope); the hosted gateway adds its own Phala/dstack quote.

**Consequences.** Closes open question 8. Agent identity uses named accounts + function-call keys + NEP-413
sign-in, which stay NEAR-native.
