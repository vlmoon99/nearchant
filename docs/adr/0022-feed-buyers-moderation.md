# ADR 0022 — Shop feed, buyer accounts, likes, reports and AI moderation

Status: accepted (3 Nov 2026)

## Context
Buyers could only reach a store through its link. The owner wants Nearchant to be a place where people look for
things: "stores that sell 1, 2, 3, 4 in my region" → a feed of posts and shorts from the stores that fit. Signed-in
buyers like posts and report bad ones. Moderation must work while the owner sleeps, and the owner (or a moderator)
resolves cases in an admin panel reachable from the tailnet only.

## Decision
- **Feed** (`/feed`, the landing's "Explore"): one search box. The `search-planner` role turns the query into goods
  (with synonyms) and a place; results combine **embeddings** (Qwen3-Embedding-0.6B on NEAR AI, public post/item/store
  text only, `embed` capability, pgvector HNSW) with Postgres full-text match. Ranking: relevance, region match, likes,
  freshness; a signed-in buyer's likes pull similar posts up ("For you"). Removed posts and suspended stores never show.
- **Region**: a store has `city`, `country` (ISO 3166-1 alpha-2) and `ships` (`local` / `country` / `world`), set in
  Settings; the `place-finder` role fills them from the store description for stores that have none. "In New York"
  matches stores in New York and stores that ship to the US or worldwide.
- **Buyers**: own accounts (`buyers`), signed in by email link (ADR 0021) or any NEAR wallet through NEAR Wallet
  Selector (Meteor, HOT, HERE, Intear, MyNearWallet, …) with a NEP-413 signed message. Separate cookie from sellers.
  Sellers' "Connect a NEAR wallet" moves to the selector too.
- **Likes**: one per buyer per post. **Follows**: buyers follow stores (Following feed; followed stores rank higher in
  "For you"). **Reports**: signed-in buyers pick a reason (rate-limited per buyer and IP). "More like this" under a
  post shows the nearest posts of other stores by meaning.
- **Moderation agent** (`moderator` role, vision, temperature 0): checks every post before it goes public (a removed
  post gets no proof), every item for sale (hidden when it breaks the rules) and every report. A violation (scam, illegal goods, sexual content, violence, hate, counterfeit, spam) is **removed at once**
  (owner's decision: no waiting for a human); the store owner sees why. Three removals suspend the store. Every
  decision is logged and can be undone in the admin panel.
- **Violators list**: each store or buyer with a removal or a ban gets a record with its NEAR accounts, emails and the
  IP addresses it used (we log IPs per account on sign-in and on posting, liking and reporting). The sign-in and feed
  pages say so. Data class: private — it never leaves our servers and is not sent to any model.
- **Admin panel** on the admin listener (`ADMIN_BIND`, the tailnet address only, never the tunnel) with a password
  (`ADMIN_PASSWORD`, Keychain / `.env`) and the moderator's name on every decision: reports queue, removed posts
  (undo), suspended stores, violators, decision log.

## Consequences
- Search costs a NEAR AI embedding call per query and per new post (cents per thousand); without NEAR AI it falls back
  to full-text search.
- A wrong automatic removal stays until a human undoes it; the log and undo make that cheap.
- Keeping IPs of rule-breakers is personal data: we keep it only for accounts in the violators list and for 180 days
  in the per-account IP log.
