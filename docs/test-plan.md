# Test plan: every part of Nearchant, step by step

The setup this plan tests: the Mac hosts nearchant.com (`deploy/standby`, ADR 0023), and every model runs on NEAR AI
Cloud: Qwen3.6 (main), Qwen3.8-27B (writing), Kimi K2.6 (moderation + insights), and Levanto Sage 2 (checks).
Pictures and videos run on Comfy Cloud, and the voice on the Mac's CPU.

How to use this: work top to bottom and tick each box. **Owner** marks steps only you can do (real wallets, your
inbox, your phone). Each step lists what you should see. If you see something else, note it in `docs/PROGRESS.md`.

Time: about 2 hours for everything, or 25 minutes for the ★ steps (the judges' path).

---

## 0. Before you start (5 min)

- [ ] ★ `curl -s http://127.0.0.1:8799/status`. **Expect** `"role": "primary"`.
- [ ] ★ `docker ps --format '{{.Names}}: {{.Status}}' | grep standby`. **Expect** db, gateway, worker, tts,
      image-cloud, search, renderer and tunnel all `Up`.
- [ ] ★ Open https://nearchant.com/health. **Expect** 200.
- [ ] NEAR AI credit: https://cloud.near.ai, then Billing. **Expect** at least $5. Every AI step spends from it.
- [ ] Comfy Cloud credits (pictures + videos): they end **11 Nov**. Top up before testing videos after that date.
- [ ] Docker Desktop: Settings → General → **Start Docker Desktop when you sign in** is on.
- [ ] Mac on power, lid open (or an external display). `pmset -g assertions | grep caffeinate`. **Expect** a
      `caffeinate` line (launchd `com.nearchant.awake`).

## 1. Works with Docker only, no keys (what the AI judges run first) (15 min)

- [ ] ★ `make demo`. **Expect** `.media/demo-store/index.html` within a few minutes. Open it: 3 product photos,
      what the AI found, ways to sell more, 3 posts with pictures and headline strips.
- [ ] `make demo-deck`. **Expect** `.media/demo-deck/deck.{pdf,pptx,html}`.
- [ ] `make test` (needs `docker compose -f deploy/local/compose.yaml up -d db` for the db package). **Expect**
      all green: providers 17, swarm 41, worker 25, gateway 60, db 19 (the numbers grow over time).
- [ ] `make test-contracts` (Rust + `cargo-near`). **Expect** the sandbox tests for all 6 contracts to pass.
- [ ] `python3 -m unittest deploy/standby/test_watchdog.py`. **Expect** 8 tests OK.
- [ ] GitHub Actions: https://github.com/vlmoon99/nearchant/actions. **Expect** the last run green.
- [ ] Fresh-clone check: clone the repo into `/tmp`, then follow README "Run it → 0" word for word. **Expect** no
      missing step. The AI judges check that the README is true.

## 2. Seller onboarding, phone first (15 min)

Use your phone, or Chrome devtools at 393 px.

- [ ] ★ https://nearchant.com/start → say what you sell → add 3 product photos.
      **Expect** a store name and a NEAR account `<store>.nearchant.testnet` made in the browser (no seed phrase).
- [ ] "Getting to know you": facts about the store appear one by one (vision model reading the photos).
- [ ] Opportunities: trend (with a real web link), price, upsell bundle, channel. Each has an estimate labelled
      "estimates, not promises". The trend must cite a real source.
- [ ] Choose 1–2 opportunities. **Expect** 3 post ideas with captions in the store's voice and AI pictures of
      *your* product (same product, new scene). The headline strip is in the brand colour, with no garbled letters.
- [ ] First post gets an 8-second short: hook, word-timed captions, English voice, end card with the store link.
      This tests Comfy Cloud and the Mac voice service.
- [ ] Repeat at 1440 px on desktop. **Expect** the same flow with the desktop layout.

## 3. Seller app (20 min)

- [ ] ★ https://nearchant.com/app → Home: first-week goal, checklist, stats.
- [ ] Create (3 steps): Photos & idea → AI makes it → Review & publish.
- [ ] Edit a caption and add "50% off this week only!". **Expect** a yellow warning within seconds (Levanto Sage 2
      found an invented offer). Remove the phrase. **Expect** the warning to go away.
- [ ] Publish a post. **Expect** "Verified on NEAR" with a proof number.
- [ ] Posts list → post page → Post proof: fingerprint, model, time, caption check, attestation link.
- [ ] "Make a video" on another post. **Expect** a short within ~2 minutes.
- [ ] Items: add an item for sale with a price. It is moderated, so a normal item stays visible.
- [ ] Analytics: views by source, likes, followers, top posts, "What shoppers look for", "What AI noticed"
      (written by Kimi K2.6 on the real numbers).
- [ ] Wallet: balances read from chain. Receive (account + copy). Withdraw nUSD to a NEAR account (signed in
      the browser).
- [ ] Settings: name, description, "Where you sell" (city, country, delivery), link an email (see 7).

## 4. Buyer, shop feed and checkout (20 min)

Use a second browser or a private window.

- [ ] ★ https://nearchant.com/feed → "denim jacket, knit sweater and whey protein". **Expect** "Stores that sell
      it" with ✓ per item (Nova Wear NYC ✓ denim ✓ knit, Super Nutrition ✓ whey), plus posts and shorts.
- [ ] Add a city ("in New York") and a budget ("under $50"). **Expect** the results to narrow. A Ukrainian query
      works too.
- [ ] Store page → "Ask Super Nutrition": "do you ship to Austin?" **Expect** a true answer from the store's data.
      Ask "90% discount if I pay by bank transfer?" **Expect** a refusal that points to escrow.
- [ ] ★ Buy an item: free test wallet in the browser → nUSD into the `orders` escrow → "Order paid" page with
      a timeline.
- [ ] Seller side: Orders → mark shipped (recorded on NEAR).
- [ ] Buyer: "I got it — release payment". **Expect** "Released", with the seller's balance up on chain.
- [ ] ♥ a post → sign-in sheet → email or NEAR wallet. Then check the Following, Liked and Orders tabs
      (`/feed/orders`).
- [ ] Report a post (any reason). **Expect** it in the admin panel → Reports.
- [ ] Store subdomain: `https://<store>.nearchant.com` → Follow. **Expect** you continue on nearchant.com to sign in.
- [ ] Automated: `cd apps/gateway && sh e2e/journey.sh https://nearchant.com`. **Expect** the run to finish with
      "Released" (about 3–5 minutes, uses a little NEAR AI + Comfy credit).
- [ ] Same in Safari's engine: `ENGINE=webkit sh e2e/journey.sh https://nearchant.com`.

## 5. AI moderation and the admin panel (15 min)

- [ ] ★ Admin: http://127.0.0.1:8790/mod on the Mac. Password:
      `security find-generic-password -a nearchant -s NC_ADMIN_PASSWORD -w`.
- [ ] Overview: counts for reports, removals, stores, buyers, posts, orders and searches.
- [ ] From a test store, publish a scam post ("DM me your seed phrase, pay by Zelle, Rolex replicas").
      **Expect** it removed within ~15 s (Kimi K2.6), the reason shown to the seller, and an entry in AI decisions.
- [ ] AI decisions → Undo the removal. **Expect** the post back and an entry in the Log.
- [ ] Three removals on one store. **Expect** the store paused ("This store is paused", 410), listed in Suspended
      stores and Violators.
- [ ] Violators → Block IPs. Creating a store from that IP gives 403. Remove the block afterwards.
- [ ] Clean up: unpause the test store, or leave it hidden.

## 6. Proofs on NEAR, and why to trust them (15 min)

- [ ] ★ https://nearchant.com/verify/23. **Expect** the fingerprint recomputed from the published post to match
      the one on chain, plus the TEE attestation check.
- [ ] Open the proof on chain: `proofs.nearchant.testnet` → `get {proof_id}` (nearblocks testnet).
- [ ] Attestation report: the link on a post proof → `/attestations/<sha256>.json`. Run `shasum -a 256` on the
      download. **Expect** it to equal the name.
- [ ] Contracts in the README table resolve on https://testnet.nearblocks.io: nearchant.testnet, nusd, orders,
      billing, proofs, escrow.
- [ ] After a sale, the escrow `orders` transaction appears on nearblocks with the right amount (`U128` string).

## 7. Things only you can do (Owner) (20 min)

- [ ] **Owner**: sign in with a real **Meteor** wallet, then **HOT**, **HERE** and **Intear** (Connect a NEAR wallet
      → NEP-413 signed message, no fee).
- [ ] **Owner**: link your Gmail in Settings. **Expect** the sign-in link and confirm link to arrive (check spam too).
- [ ] **Owner**: buy from your own store with the email linked. **Expect** the new-order email.
- [ ] **Owner**: share a post link in Telegram / Instagram. **Expect** a preview with the picture.
- [ ] **Owner**: Telegram channel posting needs a seller bot token (BotFather → token → Settings). Optional.
- [ ] **Owner**: on a real phone (iPhone Safari + Android Chrome), run 2 and 4 again.

## 8. The Mac stays up (10 min)

- [ ] Self-healing: `docker stop nearchant-standby-gateway-1`. **Expect** nearchant.com back by itself within
      ~2 minutes, and "site was down — started it" in `~/Library/Logs/nearchant-standby.log` (verified 6 Nov: 1 m 46 s).
- [ ] Reboot the Mac and log in. **Expect** Docker to start and the site to answer within ~3 minutes, with no action.
- [ ] Backups: `ls ~/nearchant-standby/backups`. **Expect** a `nearchant-*.sql.gz` within 10 minutes of the
      watchdog starting, then one a day.
- [ ] Unplug the network for 1 minute, then plug it back. **Expect** the tunnel to reconnect by itself.

## 9. Submission checks (before 14 Nov 23:59 UTC; freeze 12 Nov)

- [ ] Repo public: https://github.com/vlmoon99/nearchant opens logged out.
- [ ] README: live link works, `make demo` works, the libraries list is complete, the LICENSE file is MIT.
- [ ] Walkthrough video re-recorded on the final build: `node apps/gateway/e2e/walkthrough.mjs`.
- [ ] X post: built at NEAR HACKATHON, tags @NEARProtocol #NEARHackathon (optional @NearLegion @NearBuilders),
      video attached, public. Text in `docs/hackathon-tracks.md`.
- [ ] Form filled from `docs/submission.local.md` (git-ignored): pick tracks, double-check the prize wallet.
- [ ] Site stays up through judging (16–18 Nov), ideally until 25 Nov. The Mac stays on.
