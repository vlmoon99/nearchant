# ADR 0028: Kits: Nearchant's main parts as copy-paste folders for the community

Status: accepted (8 Nov 2026)

## Context
- The owner wants Nearchant to be more than one platform: its two main topics should be reusable by anyone,
  - **markets**: escrow on NEAR, checkout, buy widget, wallet sign-in, reliable NEAR transactions, buyer contacts, banners;
  - **content generation**: store profile from photos, posts in the store's voice, honest caption check, ideas to sell more, product pictures, headline strips, shorts, moderation, proofs on NEAR.
- The code that does this lives inside the app (`apps/`, `packages/`, `contracts/`) and is tied to Nearchant: the escrow contract needs our store-name registry and proof log, browser scripts read our page settings, the retry queue sits in our database schema.
- The owner chose **no npm packages**: a developer copies one folder into their own project, installs its few npm dependencies, imports it, and it works.

## Decision
- A new top-level `kits/` folder with `kits/market/*` and `kits/content/*`. Rules in `kits/CONVENTIONS.md`:
  - each kit is self-contained: it imports only its own files, `node:` built-ins and the npm packages in its `package.json`. Shared lines are copied, not shared;
  - settings come in through options, with no environment variables or Nearchant config inside;
  - AI goes through a function the user passes. Each content kit includes a small adapter for any OpenAI-compatible endpoint (NEAR AI, OpenAI, Ollama, vLLM);
  - every kit has a README in the same shape, tests with fakes (no network), and a runnable `example.ts`.
- **The proof:** `kits/scripts/check-copy.mjs` copies each kit alone into an empty temp folder outside the repo, runs `npm install` from its `package.json`, then typechecks and tests it. A kit counts as done only when this passes.
- Contracts become standalone Cargo crates inside their kit (`contract/`). The escrow drops the hard dependency on the handle registry and proof log: both become optional at init, so any NEAR account can sell.
- **Nearchant is not changed** by this. The kits are copies, adapted for reuse; each README's "Came from" names the app code it was taken from. Moving the app onto the kits is a later decision.

## Consequences
- Two copies of the same logic, so a fix in one place must be copied to the other until the app uses the kits. Each kit README names its source, which makes that diff easy to find.
- The standalone escrow contract has not been deployed for Nearchant; its sandbox tests are its proof.
- Live AI and ComfyUI runs are optional in the kits' examples; their tests use fakes.
