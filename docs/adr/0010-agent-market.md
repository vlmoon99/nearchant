# 0010 — NEAR AI Agent Market integration

**Context.** market.near.ai is live (REST + MCP + A2A + x402), linked from the hackathon, and fits the Agent
Economy track.

**Decision.** M0: list Alice's deck agent as a **self-hosted** market agent (HMAC-signed `hire.created` webhook →
same swarm → submit `deliverableMarkdown`), and serve an **A2A agent card** at `/.well-known/agent-card.json` for
every seller agent. Hiring market agents (flow 3 on mainnet) and an x402 endpoint for our own agents come next.

**Consequences.** The market is one more selling surface; jobs from it go through the same order, review and
proof path.
