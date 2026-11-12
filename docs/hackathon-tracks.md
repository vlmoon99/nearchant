# Nearchant at the NEAR Hackathon: build channels (tracks)

The hackathon has 13 tracks (https://nearhackathon.com). The form lets you pick every track that fits. Below, each
track says how strongly Nearchant fits, then gives a pitch for that track: what the judges of that track look for,
and the parts of Nearchant that show it. Everything named here is built and runs at https://nearchant.com on NEAR
testnet.

**Recommended picks (lead first):** 03 Privacy & Private AI (the lead story: [docs/new-era.md](new-era.md)) ·
07 Agent Economy · 04 Autonomous Business · 06 AI Security & Defense. Optional: 08 Real-World Money, 05 AI Swarms.

| # | Track | Fit |
|---|---|---|
| 07 | Agent Economy | ★★★ strong |
| 04 | Autonomous Business | ★★★ strong |
| 03 | Privacy & Private AI | ★★★ strong |
| 06 | AI Security & Defense | ★★☆ good |
| 08 | Real-World Money | ★★☆ good |
| 05 | AI Swarms | ★☆☆ partial |
| 13 | Open Innovation | fallback |
| 01, 02, 09, 10, 11, 12 | DeFi, Investment Thesis, Games, NFTs, Memecoins, Social Money | no fit, skip |

---

## 07 · Agent Economy: agents that earn, spend, negotiate, hire and pay

Every small seller on Nearchant gets their own team of AI agents with their own NEAR account
(`<store>.nearchant.testnet`). **The agents earn**: they write the store's posts, pictures and shorts, answer
shoppers ("Ask the store"), and turn visitors into escrow-paid orders. **The agents spend**: every model call is
metered and settled on chain in the `billing` contract (prepaid balance, Merkle-batched usage records), so the agent
pays for its own compute. **The agents hire**: one agent hires another (fact-checker over A2A) under an on-chain
budget in `escrow-policy`, with a spend cap, an allowlist of recipients and a threshold for human approval. Agents
sign only with function-call keys, so they never hold free money. Seller agents also have A2A agent cards and a
NEAR AI Agent Market webhook (ADR 0010). Three money flows, all on NEAR: buyer → seller (escrow), seller → platform
(metered AI), agent → agent (hiring under a policy).

## 04 · Autonomous Business: an AI-native business that runs itself

Nearchant is the AI content manager and back office for a small store. From a few product photos it learns the
business, finds ways to sell more (trend with a real web source, price, upsell bundle, channel, each with an honest
estimate), writes and illustrates posts, makes 8-second shorts with a voice, publishes, and explains the numbers in
Analytics ("What AI noticed", a weekly owner email). Sales close through NEAR escrow: the buyer pays, the seller
ships (recorded on chain), and the buyer releases, so the store gets paid with no payment processor. While the owner
sleeps, a moderator agent checks every post, item and report and pauses scam stores. A buyer-side AI search
("protein and creatine in New York under $50") brings demand to the right store. The owner's job shrinks to taking
photos and shipping.

## 03 · Privacy & Private AI: AI that protects sensitive data

A store's photos, sales, buyer messages and briefs are private, and Nearchant enforces that in the model router:
private data goes only to the seller's own GPUs or to **NEAR AI Cloud TEE models** (Qwen3.6, Qwen3.8, Kimi K2.6).
The router refuses anything else and refuses a TEE model whose attestation it cannot fetch. Each TEE answer carries
its attestation report hash into the **proof on NEAR**. The report is published (`/attestations/<sha256>.json`), and
we **verify it ourselves**: our nonce and NEAR AI's signing key bound into the Intel TDX quote, with the quote
checked by Phala's DCAP verifier. Anyone can re-check a post at `nearchant.com/verify/<id>`. Models without an
attestation (Levanto Sage) see only public data. Buyer search logs are anonymous (a daily-rotating HMAC, goods only,
never the query text).

## 06 · AI Security & Defense: spending limits, policy engines, scam detection

Security is built in at three layers. **Keys and money**: agents hold function-call keys scoped to `orders`,
`proofs` and `escrow`, and `escrow-policy` enforces spend caps, recipient allowlists and approval thresholds on
chain (sandbox-tested with near-workspaces). **Scam detection**: a moderator agent (Kimi K2.6 in a TEE, vision)
judges every post, item, store profile and buyer report. It removes seed-phrase phishing, pay-outside-escrow and
replica listings within seconds, and pauses repeat offenders. A human admin panel can undo any decision, and a
violators list links accounts by NEAR account, email and IP. **Honest AI**: Levanto Sage 2 gives a calibrated
probability that a caption promises an offer the owner never stated, and the store assistant refuses discounts and
off-escrow payment. Web pages, buyer messages and market jobs are data, never instructions: they cannot change
recipients or amounts.

## 08 · Real-World Money: merchant payments for real businesses

Nearchant is merchant payments for small sellers who sell on Instagram and Telegram today and get paid by bank
transfer and trust. The buyer pays a stablecoin (testnet `nUSD`) into the `orders` escrow from a wallet made in the
browser (no seed phrase, gas sponsored). The seller marks the order shipped on chain, and the buyer confirms
delivery, which releases the money (or it auto-releases after a timeout). Sellers see balances read from chain and
withdraw to any NEAR account. Checkout also shows what the same order would cost from another chain (a NEAR Intents
1Click dry quote; paying through Intents is the next step, mainnet only). Amounts are
`U128` strings, and an order is marked paid only after it is confirmed on chain.

## 05 · AI Swarms: multi-agent coordination

Each store runs a team of 12 agent roles defined as data (`envs/content-store`): profiler, opportunity analyst,
idea writer, caption editor, video director, localizer, learner, insight writer, moderator, search planner, place
finder and store assistant. They are split across three model seats (fast, writing, smart) with automatic fallback.
Agents hire other agents under on-chain budgets (`escrow-policy`). Each store is its own NEAR sub-account of
`nearchant.testnet`. Shop-feed searches aggregate demand across stores, and the opportunity analyst turns unmet demand
into suggestions. Collective buying and bidding are not built, so this track fits less well than the ones above.

## 13 · Open Innovation (fallback)

A social shop for the long tail: AI makes the content, NEAR makes it trustworthy. Every post and payment is
provable on chain, and every AI answer can be traced to an attested TEE.

---

## X post (demo post link): a thread

Post 1 is the demo link for the form. Each post is under 280 characters (links count as 23).

```
Built at NEAR HACKATHON: Nearchant, a prototype of the next era of web apps 🔒

TEE backend (Phala) + private AI in NEAR AI TEEs + NEAR + open source.
Your data is read only by open code, in machines nobody can look into.

nearchant.com/start @NEARProtocol #NEARHackathon
```

```
2/ Why: a useful AI has to read your photos, sales, messages, plans. Today all of that goes to someone's server in the clear.

When users don't have to worry about their data, apps can finally be deeply personal. That's the shift.
```

```
3/ The example app: a small seller's own AI agents.

A few product photos → the AI learns the store → ideas to sell more → posts with the real product in new scenes → buyers pay into a NEAR escrow → money released on delivery.
```

```
4/ How private:
• the whole server + database run in a Phala Intel TDX machine
• private data goes only to NEAR AI TEE models; we check their attestation ourselves
• every post gets a proof on NEAR anyone can re-check

nearchant.com/verify/93
```

```
5/ Agents hold their own NEAR accounts with function-call keys only, spend under on-chain limits, and settle AI usage on chain.

It's a testnet prototype, with an honest list of what's private today and what's next.
```

```
6/ MIT. Take the whole stack, 16 copy-paste kits (escrow, checkout, NEAR wallet login, proof log…), or just the architecture.

github.com/vlmoon99/nearchant
```

**Images** (1600×900, `docs/media/story/`, made by `apps/gateway/e2e/story-cards.mjs` from a live run on 13 Nov):
- Post 1: `01-new-era`, `03-learn`, `05-picture`, `06-proof`
- Post 3: `02-sell`, `04-ideas` · Post 4: `06-proof` (or `03-learn`) · Post 5: `07-pay`, `08-released` · Post 6: `09-take-it`

Tag `@PhalaNetwork` and `@near_ai` in post 4 if those handles are right (check before posting).
