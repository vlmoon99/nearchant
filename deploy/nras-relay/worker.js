// NRAS relay (Cloudflare Worker). NVIDIA's attestation service (nras.attestation.nvidia.com) answers HTML 403 to
// some networks, the owner's included. This Worker forwards exactly two NRAS calls from Cloudflare's network:
//   POST /v3/attest/gpu          (needs the caller's own "Authorization: Bearer nvapi-…" — the Worker holds no key)
//   GET  /.well-known/jwks.json  (NRAS's public signing keys)
// The answers are NVIDIA-signed JWTs; Nearchant checks their signatures against NVIDIA's keys, so a relay cannot
// fake a "true". Deploy: deploy/nras-relay/README.md.
const NRAS = "https://nras.attestation.nvidia.com";
const ALLOWED = new Set(["POST /v3/attest/gpu", "GET /.well-known/jwks.json"]);

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
