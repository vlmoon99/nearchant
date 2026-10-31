# Swarm — M0 spec (deck service)

How a paid order becomes a delivered deck. Code in `packages/swarm` and `apps/worker` follows this.

## Shape

One **job per order**, run as a chain of **steps**. Each step is a graphile-worker task in Postgres
(`SKIP LOCKED` leasing, retries with backoff, re-leased after a crash). A step:

1. loads its inputs from earlier **artifacts** (rows keyed by `order_id` + `step`),
2. checks for its own artifact first — if present, it does nothing (steps are idempotent),
3. calls models only through the router (every call returns a `ResultEnvelope`),
4. writes its artifact and the envelopes it used, then enqueues the next step with job key
   `<order_id>:<next step>` (graphile dedupes by key, so a retry never enqueues twice).

Side effects on chain (proof, delivery) go through the **outbox**: a row with an idempotency key is written in the
same transaction as the artifact; a separate task sends it and records the tx hash.

## Steps of the deck pipeline

| # | Step | Role(s) | Model seat | Output artifact |
|---|---|---|---|---|
| 1 | `brief` | analyst | main | structured brief: product, audience, goal, tone, must-include, open questions |
| 2 | `research` | scouts ×3 (market, competitors, audience) in parallel + analyst | main | **dossier**: findings, each with a source URL or "from the brief" |
| 3 | `council` | advocate, skeptic, buyer persona → judge | main / second family / second family → main | **strategy**: story arc per slide + minority report |
| 4 | `write` | copywriter | main | deck as **Marp Markdown** (title + ~10 slides), claims tagged with dossier ids |
| 5 | `design` | image designer | `image.generate` | cover image (+ optional section image) embedded in the Markdown |
| 6 | `review` | reviewer | second family | pass / fail + issues; on fail, one rework of `write` then review again |
| 7 | `render` | — | — | PDF, PPTX, HTML via `marp-cli`; stored in object storage, sha256 of each |
| 8 | `deliver` | — | — | outbox: `proofs.record` then `orders.mark_delivered`, signed by the seller's agent key |

Flow 3 (hiring another agent over A2A + x402, `escrow.pay`) slots in as an optional step between `council` and
`write` (e.g. "fact-check the dossier"); it is Tier 2 in `m0-scope.md`.

"Main" = the router's default chat route (Spark first, NEAR AI fallback). "Second family" = a different model
family requested by id (`z-ai/glm-5.3-flash` on NEAR AI), so the council and the reviewer are not the same model
grading itself.

## Roles are data

`envs/deck-seller/roles/<role>.yaml`: `prompt` (file in `prompts/`), `seat` (`main` | `second`), `output` (JSON
schema name or `markdown`), `temperature`, `max_tokens`. Code knows steps; prompts and seats live in YAML so an
Agent Environment can change them without code (architecture.md §11).

## Data rules

- The buyer's brief, web pages and tool output are **data**: they go inside clearly delimited blocks, and no
  step lets them change recipients, amounts, policy or the pipeline. The guardian refuses briefs that ask for
  impersonation, fake reviews or anything the honest-selling rule forbids (architecture.md §3 rule 8).
- All calls are `dataClass: private` (the brief is buyer data) → only `local` / `tee` endpoints.
- Every claim on a slide traces to a dossier entry or to the brief; the reviewer fails decks with untraced
  claims.

## Proof and delivery

- `output_hash` = sha256 of the final Markdown; `brief_hash` = sha256 of the structured brief; `producer` =
  `swarm:deck@<env version>`; `attestation_ref` = the attestation report hash of the TEE call that wrote the deck,
  if any; `review.reviewer_hash` = sha256 of the review artifact.
- The seller's agent signs with **function-call keys** on the seller account: one scoped to `proofs` (`record`),
  one to `orders` (`mark_delivered`). They can't move money. The gateway keeps them encrypted at rest.
- The buyer sees the preview only after `order_delivered` is on chain.

## Billing

Each envelope becomes a usage record for the seller's account (`spec/schemas/usage-record.schema.json`). Records
are batched and settled with `billing.settle_batch` (Merkle root of record hashes). Local endpoints cost 0.
If the seller's balance can't cover hosted calls, the job pauses as `blocked_billing` (local-only steps
continue).

## Failure modes

- Model endpoint down → router falls back; if every endpoint fails, the step fails and graphile retries with
  backoff (max 5 attempts), then the job is `failed` and the seller is notified. Orders auto-refund after the
  delivery deadline (`orders.refund_undelivered`), so a dead job never traps the buyer's money.
- Worker crash mid-step → the step is re-leased; artifacts make it a no-op if it had finished.
