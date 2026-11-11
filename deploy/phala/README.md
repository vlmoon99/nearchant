# Deploying Nearchant to a Phala Cloud CVM (Intel TDX)

The judged deployment (ADR 0007, 0019, 0030): gateway, worker, Postgres, the image service (a Comfy Cloud client),
SearXNG and the Marp renderer in one CVM (`tdx.medium`, 2 vCPU / 4 GB, about $0.12 an hour). The CVM runs no
models: text, vision, embeddings and speech-to-text go to NEAR AI Cloud TEE models, pictures to Comfy Cloud. Videos
are off (no hosted voice model yet).

## What the owner does

1. **Phala Cloud API key.** cloud.phala.com → your account (top right) → **API Keys** → **Create**. The key starts
   with `phak_`. A key that starts with `sk-rp-` is for Phala's AI models (RedPill), not for servers.
   Save it in the Keychain from the Claude Code prompt, so it never appears in the chat:
   `! security add-generic-password -U -a nearchant -s PHALA_CLOUD_API_KEY -w`
2. **Credit** on the Phala account: about $2.85 a day.
3. **Comfy Cloud credits** for pictures: without them, posts use the seller's own photo.

The image packages on GitHub (`ghcr.io/vlmoon99/nearchant-app`, `nearchant-image`) are already public.

## What Claude does (in order)

1. Build the images: Actions → `images` → Run workflow, then pin the digests in the deploy env.
2. Create the CVM with the secrets in Phala's encrypted env (from the Keychain; never in a file in the repo), and
   **without** `CF_TUNNEL_TOKEN` at first, so it doesn't take traffic from the Mac.
3. Stop the Mac's watchdog (it would start the Mac site again when it sees the Spark down) and pause new orders.
4. Copy the data: `pg_dump` of the Mac's database and the media folder into the CVM.
5. Set `CF_TUNNEL_TOKEN` on the CVM; stop the Mac's tunnel. Never two tunnels on two databases.
6. Check: `https://nearchant.com/health`, a post's `/verify/<n>` "unchanged", sign-in by email, a test order from
   payment to release, a new store's posts with pictures.

## Secrets (Phala encrypted env)

`POSTGRES_PASSWORD` (new), `NEARCHANT_SECRET_KEY` (**the same** as on the Mac, or sealed keys can't be opened),
`NEAR_RELAYER_KEY`, `NEARAI_API_KEY`, `COMFY_API_KEY`, `IMAGE_API_KEY`, `RESEND_API_KEY`, `ADMIN_PASSWORD`,
`NVIDIA_API_KEY`, `NRAS_URL`, `CF_TUNNEL_TOKEN`, plus `NEARCHANT_IMAGE` and `IMAGE_SERVICE_IMAGE` (digests).

The admin panel listens on 8790 inside the CVM only; reach it with `phala ssh` port forwarding.
