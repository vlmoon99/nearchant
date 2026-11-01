# Deploying to Phala Cloud (judged deployment)

Target (ADR 0007): around 12 Nov the gateway runs in a Phala CVM, using NEAR AI Cloud TEE models only
(`config/providers.cloud.yaml`) and serving `*.nearchant.com` through the same Cloudflare tunnel as the Spark.

## Owner prerequisites

1. Phala Cloud account with credit; `PHALA_CLOUD_API_KEY`.
2. Cloudflare tunnel token for `*.nearchant.com` (same tunnel as the Spark → Cloudflare fails over between them).
3. A container registry the CVM can pull from (GHCR under the repo owner is fine; the image is public, no secrets in
   it).

## Steps

```bash
# 1. Build multi-arch and push; note the digest (the attestation binds it)
docker buildx build -f deploy/Dockerfile --platform linux/amd64,linux/arm64 -t ghcr.io/<owner>/nearchant:m0 --push .
docker buildx imagetools inspect ghcr.io/<owner>/nearchant:m0   # → sha256:…

# 2. Deploy (secrets as encrypted env, never in the compose file)
phala deploy -n nearchant-gw -t tdx.medium -c deploy/phala/compose.yaml \
  -e NEARCHANT_IMAGE=ghcr.io/<owner>/nearchant@sha256:… -e POSTGRES_PASSWORD=… \
  -e NEARCHANT_SECRET_KEY=… -e NEAR_RELAYER_KEY=… -e NEARAI_API_KEY=… -e CF_TUNNEL_TOKEN=… --wait

# 3. Move state from the Spark (same as the Mac → Spark move): pg_dump | pg_restore, copy the media volume.
```

## Differences from the Spark deployment

- No local model endpoints: every call is `tee` tier on NEAR AI; costs are billed to sellers from the catalog prices.
- Web search runs in the CVM: the bundled `search` service (SearXNG, JSON API, no limiter) replaces the tailnet
  SearXNG the Spark used.
- The `NEARCHANT_SECRET_KEY` must be the same as on the Spark, or sealed agent keys can't be opened after the move.
