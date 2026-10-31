# 0008 — Wildcard tunnel instead of an edge Worker in M0

**Decision.** `*.nearchant.com` (one level, covered by Universal SSL) routes through one Cloudflare Tunnel to the
gateway. The gateway takes the first label of the host, looks the handle up in a cache fed by `handles` contract
events, and serves the card or a 404 card. Every gateway node runs a connector, so Cloudflare fails over between
them.

**Consequences.** `apps/edge` (proxying self-hosted sellers' own tunnels, custom domains) moves after M0. The
`Host` header is only a lookup key; the handle record decides which seller a request belongs to.
