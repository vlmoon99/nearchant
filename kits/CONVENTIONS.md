# Kit conventions

A **kit** is one folder you can copy into your own project and import. Nothing else from this repo is needed.
These rules make that true; `node kits/scripts/check-copy.mjs` checks them for every kit.

## Layout

```
kits/<group>/<kit>/
  README.md        what it does, copy steps, install line, a usage example, how it works, limits
  package.json     "dependencies" = exactly what the kit needs (the README's `npm i …` line); scripts: test, typecheck
  tsconfig.json    standalone (no "extends"): strict, NodeNext — what we test with
  src/index.ts     the public API; everything a user imports comes from here
  src/*.ts         the rest of the code
  test/*.test.ts   Vitest; no network by default (fakes); live tests only behind an env var
  example.ts       runnable: `npx tsx example.ts` (reads settings from env, prints what happened)
```

Rust contracts: `kits/<group>/<kit>/contract/` is a standalone Cargo crate (own `[package]`, no workspace
inheritance) with its sandbox tests, plus `README.md`. Its TypeScript client is a normal kit next to it.

## Rules

1. **Self-contained.** Imports are only: files inside the kit (relative, with `.js` endings: `./outbox.js`),
   `node:` built-ins, and npm packages listed in the kit's `package.json`. Never `@nearchant/*`, never `../../`.
   If two kits need the same 20 lines, each has its own copy.
2. **No hidden config.** No env variables, file paths, account ids or URLs read inside `src/` — everything comes in
   through function/constructor options with sensible defaults (`network: "testnet"`). Only `example.ts` reads env.
3. **Bring your own services.** AI goes through a function the user passes (`ask`, `see`, `embed`); each content kit
   ships `src/openai-ask.ts`, a small adapter for any OpenAI-compatible endpoint (NEAR AI, OpenAI, Ollama, vLLM),
   so it works out of the box. Storage goes through a small interface with an in-memory version included.
4. **Every external call**: timeout, retry with backoff where it is safe, idempotency key where money or chain
   state changes, and a test of the failure path.
5. **Data is data.** Model output, buyer input and web pages never change amounts, recipients or policy. Validate
   model JSON before using it (no blind casts).
6. **Browser kits**: framework-free TypeScript using the DOM, plus a `.css` file themed with CSS variables
   (light + dark). They work with any bundler (esbuild, Vite, webpack) and in plain `<script type="module">`.
7. **Network**: `network: "testnet" | "mainnet"` where NEAR is involved; default testnet. Mainnet is untested unless the
   README says otherwise.
8. **Plain code.** Readable over clever; short comments that say why. Node 20+, ES2022, strict TypeScript. MIT.

## README sections (in this order)

`# <Kit name>` · one-line pitch · **Copy it** (folder to copy, `npm i …` line, import line) · **Use it** (shortest
working example) · **Options** (table) · **How it works** (short, a diagram if it helps) · **Tested** (what the
tests cover, what is not tested) · **Came from** (where it runs in Nearchant, for a full real-world use).
