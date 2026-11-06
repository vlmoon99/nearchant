// NRAS relay (Cloudflare Worker). NVIDIA's attestation service (nras.attestation.nvidia.com) answers HTML 403 to
// some networks, the owner's included. This Worker forwards only these NRAS calls from Cloudflare's network:
//   POST /v4/attest/gpu, /v3/attest/gpu   (needs the caller's own "Authorization: Bearer nvapi-…" — the Worker holds no key)
//   GET  /.well-known/jwks.json  (NRAS's public signing keys)
// It runs in the owner's own Cloudflare account; NVIDIA's signed answer is published with each check, so others can
// verify it against NVIDIA directly. Deploy: deploy/nras-relay/README.md.
const NRAS = "https://nras.attestation.nvidia.com";
const ALLOWED = new Set(["POST /v4/attest/gpu", "POST /v3/attest/gpu", "GET /.well-known/jwks.json"]);

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (!ALLOWED.has(`${request.method} ${url.pathname}`)) return new Response("not found", { status: 404 });
    const headers = { accept: "application/json" };
    if (request.method === "POST") {
      const auth = request.headers.get("authorization") ?? "";
      if (!auth.startsWith("Bearer nvapi-")) return new Response("missing NVIDIA key", { status: 401 });
      headers.authorization = auth;
      headers["content-type"] = "application/json";
    }
    const body = request.method === "POST" ? await request.text() : undefined;
    if (body && body.length > 2_000_000) return new Response("too large", { status: 413 });
    const r = await fetch(`${NRAS}${url.pathname}`, { method: request.method, headers, body });
    return new Response(r.body, { status: r.status, headers: { "content-type": r.headers.get("content-type") ?? "application/json" } });
  },
};
