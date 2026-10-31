# 0016 — Runtime validation with Ajv straight from the JSON Schemas

**Context.** The plan said "JSON Schema as source of truth, Zod at runtime". Zod would need a second,
generated copy of every schema.

**Decision.** `packages/contracts` generates TypeScript types from `spec/schemas` (json-schema-to-typescript) and
validates at runtime with Ajv (draft 2020-12) loaded from the same files. One source, no drift.

**Consequences.** Hand-written request shapes inside a service may still use Zod locally; anything that crosses a
boundary (config, envelopes, usage records, community environments) is validated against `spec/schemas`.
