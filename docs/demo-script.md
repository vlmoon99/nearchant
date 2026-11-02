# Demo video — about 100 seconds (the content store, ADR 0018; shop feed + moderation, ADR 0022)

One take on nearchant.com: desktop for the landing and the seller app, phone size (393 px) for onboarding and the
buyer. Everything is live on NEAR testnet; AI steps are sped up where marked (×4). Prepare: a fresh browser
profile, the 3 photos in `fixtures/replay/store/photos/`, the NEAR explorer on `proofs.nearchant.testnet`.
An automated walkthrough of the same flow is recorded by `apps/gateway/e2e/walkthrough.mjs` (see README).

| Time | Screen | Voice |
|---|---|---|
| 0:00 | nearchant.com — "Posts that sell. Paid and proven on NEAR." (real counts, real posts with proofs) | "Small sellers don't have time for marketing. Nearchant is their AI content manager — and their payments run on NEAR." |
| 0:07 | "Create your store — free" → name → Continue | "Two taps and the store has its own NEAR account — made in the browser, no seed phrase." |
| 0:13 | Add 3 photos → Analyze (×4) — facts appear | "AI reads the photos on our own GPUs: the products, the style, who buys, what gets saves." |
| 0:22 | "We found 2 ways to sell more" with estimates | "Then it finds ways to sell more — a bundle, a channel — with honest estimates." |
| 0:30 | First posts with headline pictures (×4) → Schedule all | "First posts in a minute: captions in the store's voice, the real product in new scenes, a headline in the brand colour." |
| 0:40 | The 8-second short of the first post (play it) | "And a short for Reels: a hook, captions, a voice, and where to buy." |
| 0:48 | Edit a caption to "50% off today!" → yellow warning | "An AI check on NEAR AI stops offers the owner never made." |
| 0:54 | Post detail → "Proof on NEAR" → explorer `get` → "our check" | "When a post goes live, the store's key records a proof on NEAR — and which AI wrote it, inside a verified TEE." |
| 1:04 | Storefront on a phone → item → Pay into escrow | "A buyer pays with a free test wallet. The money waits in escrow on NEAR — not with us." |
| 1:12 | Seller: Mark shipped → buyer: "I got it" → Released | "The seller ships, the buyer confirms, and the escrow pays the store." |
| 1:18 | nearchant.com/feed on a phone: "protein and creatine in New York" → results with "In New York / Ships worldwide" → ♥ → sign in with a NEAR wallet (Meteor/HOT) | "Buyers don't need another social network: they search Nearchant itself — in plain words, in their city — and like what they want." |
| 1:26 | Report a post → admin panel (tailnet): the AI already removed it, with the reason | "Bad posts are caught by an AI moderator before anyone has to look — a person can always undo it." |
| 1:32 | Home: "Your first sale! 🎉" → Analytics → Settings → Connect a NEAR wallet | "What sold, what to do next, the balance from the chain — and your own NEAR wallet to sign in anywhere. Open source, MIT. Nearchant." |

## Shots for the X post
1. The landing hero with real posts. 2. A headline post picture next to the original product photo. 3. A frame of
the short (hook box). 4. Proof on the explorer + the attestation check. 5. "Your first sale!" card.
