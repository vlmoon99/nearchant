# M1 plan — the Figma product (AI content + analytics + NEAR payments)

Decided in ADR 0018. Design: Figma `Nearchant` → page "Nearchant — all screens" (rows: web app, mobile web,
storefront, landing & web onboarding, onboarding mobile web). This file is the build order; the loop takes the
first unchecked item, finishes it with tests, commits, and logs it in `PROGRESS.md`.

Deadlines unchanged: feature freeze 12 Nov, submission 14 Nov 23:59 UTC.

## Rules for this phase

- Models during development: `providers.local.yaml` only (Qwen3.6 text+vision on `gx10-8695`, own ComfyUI).
  **No NEAR AI calls until step 14.** NEAR AI credit is ~$2: if a call fails with a billing/credit error, stop and
  ask the owner to top up.
- Reuse Boost Content (`~/Documents/dev/boostcontent_backend`, `boostcontent_client/inference_system`) by porting
  prompts, shapes and contracts — never change those repos or the shared `inference_system` cluster.
- Mobile-first web: every page works at 393 px and 1440 px (one codebase, responsive).
- Store photos and generated images under the existing media volume; signed URLs later if needed.

## Build order

1. [x] **Image engine on gx10-8695**: ComfyUI + Qwen-Image-Edit-2511 (weights in `~/nearchant-node/comfy`),
   an OpenAI-shaped images service (port of `inference_system/services/image/app.py`, `/v1/images/generations`
   with `image_b64`/`image_url`), compose service `image`, router endpoint `spark-image` (`image.generate`,
   `image.edit`) in `providers.local.yaml`. Verify: one product photo → restyled 1024×1280 PNG.
2. [x] **Data model**: Drizzle migration for businesses, profiles, items, media, posts, post_images, signals,
   events, opportunities; quota helpers (reserve/refund) from Boost Content's plans (free: 12 posts/month).
3. [x] **Uploads + business API**: create business (what you sell, name), photo upload (multipart → media),
   link field; JSON endpoints used by the pages.
4. [x] **Analyze pipeline** (worker): vision profile prompt (port of Boost Content `profile`), facts streamed to
   the "Getting to know you" screen; replay fixture + tests.
5. [x] **Opportunities pipeline** (trends need live web search — see PROGRESS 1 Nov 23:00): trend (SearXNG), price (similar items), upsell bundle, channel — each with an
   estimate and the "estimates, not promises" rule; tests.
6. [x] **Posts pipeline**: ideas (port of `ideas` prompt, seeded by chosen opportunities) → caption → image
   (Qwen-Image-Edit from the product photo) → ready; choose/pass/edit signals; learn memory.
7. [x] **Publish + proof** (Telegram channel posting waits for a seller bot token): publishing a post writes a `proof-log` entry (hash of caption + image) and shows it on
   the store; Telegram channel post via the seller's bot (existing ADR 0011 code).
8. [x] **UI foundation**: CSS tokens from the Figma variables + type styles, layout shell (desktop sidebar,
   mobile web bottom nav), components (badge "Verified on NEAR", stat card, post card, buttons, chips).
9. [x] **Onboarding pages** (10 screens, mobile web first) wired to steps 3–6.
10. [x] **Seller app pages**: Home, Create (3 steps), Posts, Post detail + proof.
11. [x] **Storefront**: store page from items/posts, item page, checkout (existing sponsored wallet + `orders`
    escrow), order paid page with timeline and "I got it — release payment".
12. [x] **Analytics + Wallet + Settings**: page-view/click/sale events, weekly charts, AI insights (LLM over the
    numbers), first-week goal + checklist, first-sale celebration, Monday report; wallet from chain views.
13. [x] **Public URL + polish**: tunnel routes live (owner adds hostnames), end-to-end browser test of onboarding →
    post → buy → release; `make demo` replay updated to the new story; README + demo script.
13a. [x] **Landing at nearchant.com** (Figma "Landing", missed in the first build order; done 1 Nov).
13b. [x] **Stretch: video posts + English voiceover** (owner request 1 Nov): port from `advertisment_system` (details: `docs/video-plan.md`)
    (video model + Kokoro-style English TTS, no uk/ru). Needs a GPU decision: gx10-8695 can't hold LLM + image +
    video at once; options are the second Spark (`gx10-c3c8`, Boost Content's box — owner's call) or time-sharing.
    **Done 1 Nov** on Comfy Cloud (Wan 2.2 TI2V 5B clip) + Kokoro voice on CPU + ffmpeg captions — "Make a video"
    on a post. LTX-2.5 on `gx10-c3c8` stays built but unused until its memory cap is tested.
14. [ ] **NEAR AI TEE at the end**: switch text to NEAR AI TEE models (`providers.yaml`), attestation in proofs,
    a paid test (owner topped up +$20 on 1 Nov); Phala deploy if the owner provides the account. For the full-cloud
    production profile, pick the model per task with NEAR AI's **Levanto Sage 1.4** router ("Decisions", private TEE,
    $0.07 in / $2 out per M, 32K context) — production only; local/dev keeps one LLM.
    **Progress 1 Nov:** text on NEAR AI TEE (Mac stack) ✓; attestation in proofs ✓ (proof #18 cites
    `nearai:<model>:<report sha256>`, report public at `/attestations/<sha256>.json`). Open: Levanto Sage router,
    quote verification (reports are pinned, not yet cryptographically verified), Phala deploy (owner account).

## Night of 1→2 Nov (owner asleep until 10:00 EET) — work list, in order
1. [x] Sparks: images + video only on Comfy Cloud — stop local ComfyUI/image on gx10-8695 (frees ~28 GB), unused
       `ncvideo` stack and Boost Content `inf-*` on gx10-c3c8; fallback image route → Comfy Cloud (image-cloud).
2. [x] "Connect a NEAR wallet" (Figma onboarding 1): sign in with the owner's NEAR wallet (NEP-413 signed message).
3. [x] Step 14 remainder: verify NEAR AI attestation reports ourselves (as far as possible without Phala).
4. [ ] Submission: README + demo script up to date; an automated walkthrough video of the full flow.
5. [ ] Full regression: journey e2e (Chrome + WebKit), make demo, CI, phone/desktop pass over every page.
6. [ ] Morning report in PROGRESS.md: done / verified / owner actions.

## Status

See `PROGRESS.md` for dated entries.
