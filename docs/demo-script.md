# Demo video — 90 seconds

One take, screen recording + voice. Everything shown is live on NEAR testnet; the agent part is sped up (×8)
where marked. Prepare: a fresh browser profile (so a new test wallet is created), Alice's card open, the manage
page in a second tab, a NEAR explorer tab on `orders.nearchant.testnet`.

| Time | Screen | Voice |
|---|---|---|
| 0:00 | Alice's card `alice.nearchant.com` | "This is Alice. She doesn't make pitch decks — her agents do. Nearchant gives every seller a NEAR account, a shop, and an agent team that sells and delivers for them." |
| 0:10 | Type a brief, click **Order** | "A buyer describes their startup and pays five test dollars. No wallet to install — on testnet we sponsor one in the browser." |
| 0:18 | Status: "Paying into escrow… From another chain via NEAR Intents: about 5.06 USDC on Solana" | "The money goes into escrow on NEAR. And this is a live NEAR Intents quote: the same buyer could pay from Solana." |
| 0:25 | Order page, steps ticking (×8) | "Now the agents work. Scouts research the market on the live web. A council — an advocate, a skeptic, a buyer persona and a judge, on two different model families — agrees on the story." |
| 0:40 | Worker log line `hire: escrow payment → verity.nearchant.testnet` | "Alice's agent hires another agent — Verity, a fact-checker — over A2A, and pays it from an escrow budget. The contract enforces Alice's limits: two dollars per hire, only allowlisted agents." |
| 0:52 | Steps: write, cover, review | "Every claim must cite a source. An independent reviewer can block the deck; unsupported lines are removed, not shipped." |
| 1:00 | "Your deck" — slide preview, PDF / PPTX | "Delivered. The deck's hash, the brief's hash and the TEE attestation of the model that reviewed it are recorded on NEAR before the buyer sees it." |
| 1:08 | Click **Accept** → "escrow: Released" | "The buyer accepts, and the escrow pays Alice." |
| 1:13 | Manage tab: wallet, inference balance, hiring budget | "Alice pays only for what her agents used — local GPU calls are free, NEAR AI TEE calls are metered and settled on chain with a Merkle root anyone can verify." |
| 1:22 | `/new` page | "Anyone can open a shop in a minute. Open source, MIT. Nearchant." |

## Shots to capture separately (for the X post)

1. The order page with the slide preview and "escrow: Released".
2. The manage page money table.
3. `make demo` in a terminal finishing in 3 seconds.
4. The proof entry on the explorer (`proofs.nearchant.testnet` → `get`).
