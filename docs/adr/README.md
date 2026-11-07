# Architecture Decision Records

One file per decision: context, decision, consequences. Status is `accepted` unless marked otherwise.
Changing a default from `CLAUDE.md` or `architecture.md` needs a new ADR here.

| # | Decision |
|---|---|
| [0001](0001-testnet-and-nusd.md) | Develop and demo on testnet with the free `nUSD` test token |
| [0002](0002-drop-shade-agents.md) | Drop the Shade Agent Framework |
| [0003](0003-one-demo-story.md) | One demo story: an agent-fulfilled service covering all three money flows |
| [0004](0004-payment-rail.md) | `PaymentRail` interface: `testnet-direct` and `intents-1click` |
| [0005](0005-billing-profiles.md) | Billing on in `operator`, compiled out in `free-local` |
| [0006](0006-local-models-via-inference-system.md) | Local models through the owner's existing inference cluster |
| [0007](0007-spark-primary-phala-standby.md) | Spark primary, Phala hot standby, manual failover |
| [0008](0008-wildcard-tunnel.md) | `*.nearchant.com` through one Cloudflare Tunnel, no edge Worker in M0 |
| [0009](0009-campaign-budget-subaccounts.md) | Flow 3 budgets as subaccounts; fee only between Nearchant agents |
| [0010](0010-agent-market.md) | NEAR AI Agent Market: list as a self-hosted agent, serve A2A cards |
| [0011](0011-per-seller-telegram-bots.md) | Telegram: each seller brings their own bot token |
| [0012](0012-marp-deliverable-and-acceptance.md) | Decks as Marp Markdown; buyer acceptance releases payment |
| [0013](0013-replay-provider.md) | Replay provider so judges run the demo with no accounts |
| [0014](0014-node-24.md) | Node 24 LTS instead of Node 22 |
| [0015](0015-doc-split.md) | Split the plan into CLAUDE.md, architecture, scope and ADRs |
| [0016](0016-ajv-from-json-schema.md) | Ajv from the JSON Schemas instead of Zod for boundary validation |
| [0017](0017-second-seat-must-be-attested.md) | The council's second model family must be TEE-attested |
| [0018](0018-pivot-to-ai-content-store.md) | Pivot to the Figma product: AI content + analytics + NEAR payments for small sellers |
| [0019](0019-models-media-and-trust-checks.md) | Two Sparks for the LLMs, Comfy Cloud for media, our own trust checks |
| [0020](0020-mac-standby.md) | Mac standby: database replica + media copy, automatic takeover, manual failback |
| [0021](0021-email.md) | Email via Resend: sign-in links, confirm links, new-order emails |
| [0022](0022-feed-buyers-moderation.md) | Shop feed with AI search + region, buyer accounts, likes, reports, AI moderation, admin panel |
| [0023](0023-mac-only-cloud-models.md) | Mac-only hosting with self-healing + backups; all models on NEAR AI; a smart seat (Kimi K2.6); Levanto Sage 2 |
| [0024](0024-safety-check-before-publish.md) | Safety check on drafts; a flagged draft is held, not removed; AI post editor (fix, ask, new picture, skip) |
