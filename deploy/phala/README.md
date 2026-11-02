# Deploying Nearchant to a Phala Cloud CVM (Intel TDX)

The judged deployment (ADR 0007, 0019): gateway + worker + Postgres + image service (Comfy Cloud) + TTS in one CVM.
Text, vision and caption checks run on NEAR AI Cloud TEE models; pictures and video on Comfy Cloud.

## Images (pinned by digest — the attestation report binds exactly this code)

Built by the `images` workflow (Actions → images → Run workflow) from commit `7d5568c`:

```
NEARCHANT_IMAGE=ghcr.io/vlmoon99/nearchant-app@sha256:98e99eebae15f1185046d5e83066cad2073a33f127e9d7a22289c04453107556
IMAGE_SERVICE_IMAGE=ghcr.io/vlmoon99/nearchant-image@sha256:38f3c95cfe10989b7ba2b4960bb8e64eef3ad7bdab7c56cae81dfd919d3cdbb3
TTS_IMAGE=ghcr.io/vlmoon99/nearchant-tts@sha256:8f3cf7121ad1e748b2311bc5352ebf1eb34cc158b33b2ee39715588c5db2858f
```

The packages are private on GitHub at first: make them public (GitHub → Packages → each package → Package
settings → Change visibility) or give Phala a registry token.

## Steps (owner)

1. Create a Phala Cloud account with credit; install the CLI (`npx phala auth login`).
2. Secrets — set them in the Phala dashboard (encrypted env), never in a file in the repo. `.env.example` lists them.
3. `npx phala cvms create --name nearchant --compose deploy/phala/compose.yaml --env-file <your local, git-ignored env>`
4. The CVM's `cloudflared` joins the same tunnel as the Spark. **Stop the Spark tunnel first** (never two tunnels on
   two databases), after copying the Spark database: `pg_dump` from the Spark, `pg_restore` into the CVM's db.
5. Check: `https://nearchant.com/` 200, `/verify/23` shows "unchanged", a new store's posts get pictures.
