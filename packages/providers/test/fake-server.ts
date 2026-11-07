import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface Fake {
  url: string;
  hits: { path: string; body: any; auth?: string }[];
  /** Respond with this status for the next N chat calls. */
  failNext: (n: number, status?: number) => void;
  /** Every chat call for this model answers 502 (a model outage). */
  breakModel: (model: string) => void;
  close: () => Promise<void>;
}

/** A tiny OpenAI-compatible server: /v1/models, /v1/chat/completions, /v1/embeddings, /v1/attestation/report. */
export async function fakeOpenAI(models: string[], reply = "ok"): Promise<Fake> {
  const hits: Fake["hits"] = [];
  // A model TEE key: the report names it, and /v1/signature signs answers with it (NEAR AI's provider_tee shape).
  const tee = generateKeyPairSync("ed25519");
  const teePub = tee.publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("hex");
  const sha = (x: string) => createHash("sha256").update(x).digest("hex");
  const answers = new Map<string, { model: string; request: string; response: string }>();
  let fails = 0;
  const broken = new Set<string>();
  let failStatus = 500;
  const server: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : undefined;
    const path = req.url ?? "";
    hits.push({ path, body, auth: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    if (path === "/v1/models") return res.end(JSON.stringify({ data: models.map((id) => ({ id, pricing: { prompt: "0.000003", completion: "0.000004", image: "0.01" } })) }));
    if (path.startsWith("/v1/attestation/report")) return res.end(JSON.stringify({ gateway_attestation: { signing_address: "0xabc" }, model_attestations: [{ signing_address: teePub, signing_algo: "ed25519" }] }));
    if (path.startsWith("/v1/signature/")) {
      const a = answers.get(decodeURIComponent(path.split("/")[3]!.split("?")[0]!));
      if (!a) { res.statusCode = 404; return res.end("{}"); }
      const text = `${a.model}:${sha(a.request)}:${sha(a.response)}`;
      return res.end(JSON.stringify({ text, signature: sign(null, Buffer.from(text), tee.privateKey).toString("hex"), signing_address: teePub, signing_algo: "ed25519", signature_kind: "provider_tee" }));
    }
    if (path === "/v1/chat/completions") {
      if (broken.has(body.model)) { res.statusCode = 502; return res.end(JSON.stringify({ error: "model down" })); }
      if (fails > 0) {
        fails--;
        res.statusCode = failStatus;
        return res.end(JSON.stringify({ error: "boom" }));
      }
      const id = `chatcmpl-${hits.length}`;
      const out = JSON.stringify({
        id,
        model: body.model,
        choices: [{ message: { role: "assistant", content: reply }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      });
      answers.set(id, { model: body.model, request: raw, response: out });
      return res.end(out);
    }
    if (path === "/v1/systemone") {
      const answers = Object.fromEntries(Object.entries(body.questions ?? {}).map(([id, q]: [string, any]) => [id, q.type === "noul" ? { type: "noul", noul: 0.9 } : { type: q.type, choice: Object.keys(q.criteria ?? {})[0] }]));
      return res.end(JSON.stringify({ model: "levanto-sage-2", answers, usage: { input_tokens: 42, output_tokens: 0 } }));
    }
    if (path === "/v1/embeddings") {
      return res.end(JSON.stringify({ model: body.model, data: [{ embedding: [0.1, 0.2, 0.3] }], usage: { prompt_tokens: 3 } }));
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    hits,
    failNext: (n, status = 500) => { fails = n; failStatus = status; },
    breakModel: (m) => { broken.add(m); },
    close: () => new Promise((r) => server.close(() => r())),
  };
}
