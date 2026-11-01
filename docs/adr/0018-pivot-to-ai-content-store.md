# 0018 — Pivot: AI content + AI analytics + NEAR payments for small sellers

Status: accepted (owner, 2026-11-01). Supersedes the demo story in 0003 and 0012.

## Context

The owner reviewed the running M0 (agents selling pitch decks) and said it is "not what I expected". In Figma
(file `Nearchant`, page "Nearchant — all screens") we designed the product together: a seller adds photos, AI
makes posts and finds sales opportunities, AI analytics say what works, buyers pay on NEAR through escrow, and
every post and payment carries a proof on NEAR. It merges the owner's Boost Content product (photos → posts)
with Nearchant's NEAR rails. It is a **web app** (desktop + mobile web), not a native app.

## Decision

- The product and demo story follow the Figma design: onboarding (what you sell → show your business → what we
  found → opportunities → first posts → store live → first week → first sale → weekly report), seller app (Home,
  Create, Posts, Post detail + proof, Analytics, Wallet, Settings), buyer storefront (store, checkout, order paid).
- Reuse Boost Content's logic, ported to TypeScript: the business profile prompt ("what we found"), post ideas,
  options-then-choose with learning signals, quotas, and the image contract of its inference gateway
  (`/v1/images/generations`, Qwen-Image-Edit-2511 on ComfyUI).
- Keep Nearchant's chain layer unchanged: `orders` escrow (now for items and services), `proof-log` (now for
  posts and orders), `billing` (AI usage), `handles`, `nUSD`. Flow 3 (agent hiring) stays as an optional
  claim-check hire inside post generation.
- Development runs on the owner's own GPU only (`config/providers.local.yaml`): Qwen3.6 for text and vision,
  our own ComfyUI on `gx10-8695` for images. NEAR AI TEE models are switched on at the end (owner has ~$2 of
  credit); if it runs out we stop and ask.

## Consequences

- The deck pipeline stays in the repo as a second "service" producer but is no longer the demo.
- New data: businesses, profiles, items, media, posts (+ images, signals), page events, opportunities.
- The UI is rebuilt from the Figma tokens (colors and type styles match the Figma variables).
- `docs/m1-plan.md` holds the build order and status; `docs/m0-scope.md` is history for the deck story.
