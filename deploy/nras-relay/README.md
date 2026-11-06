# NRAS relay (optional)

NVIDIA's attestation service refuses some networks with an HTML 403 at its load balancer, before it reads the API
key. In that case the GPU part of our TEE check reads "not checked" (`gpu_error: "NRAS 403"`). This Worker sends
the two NRAS calls through Cloudflare instead. The Worker holds no key. It runs in your own Cloudflare account,
and it also relays NVIDIA's public keys, so trusting it means trusting your account. For outsiders, NVIDIA's signed
answer is published in each report's `.check.json` (`gpu_token`), and anyone on an unblocked network can verify it
against https://nras.attestation.nvidia.com/.well-known/jwks.json.

## Deploy (about 3 minutes, free plan)
1. Cloudflare dashboard → Workers & Pages → Create → Worker → name `nras-relay` → Deploy → Edit code.
2. Replace the code with `worker.js` from this folder, then Deploy.
3. Test it: `curl -s https://nras-relay.<your-subdomain>.workers.dev/.well-known/jwks.json` should return JSON with
   `"keys"`. If you get 403 HTML here too, NVIDIA also blocks Cloudflare's network from your region. The check then
   stays "not checked" until the site runs elsewhere (for example on Phala).
4. `security add-generic-password -U -a nearchant -s NC_NRAS_URL -w https://nras-relay.<your-subdomain>.workers.dev`
5. `deploy/standby/mac-only.sh`. New attestation reports are then checked by NVIDIA too, and "Verify a post" says
   "NVIDIA confirmed the GPU".
