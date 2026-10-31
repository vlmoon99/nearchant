import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface Fake {
  url: string;
  hits: { path: string; body: any; auth?: string }[];
  /** Respond with this status for the next N chat calls. */
  failNext: (n: number, status?: number) => void;
  close: () => Promise<void>;
}

/** A tiny OpenAI-compatible server: /v1/models, /v1/chat/completions, /v1/embeddings, /v1/attestation/report. */
export async function fakeOpenAI(models: string[], reply = "ok"): Promise<Fake> {
  const hits: Fake["hits"] = [];
  let fails = 0;
  let failStatus = 500;
  const server: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : undefined;
    const path = req.url ?? "";
    hits.push({ path, body, auth: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    if (path === "/v1/models") return res.end(JSON.stringify({ data: models.map((id) => ({ id, pricing: { prompt: "0.000003", completion: "0.000004", image: "0.01" } })) }));
    if (path.startsWith("/v1/attestation/report")) return res.end(JSON.stringify({ gateway_attestation: { signing_address: "0xabc" } }));
    if (path === "/v1/chat/completions") {
      if (fails > 0) {
        fails--;
        res.statusCode = failStatus;
        return res.end(JSON.stringify({ error: "boom" }));
      }
      return res.end(JSON.stringify({
        model: body.model,
        choices: [{ message: { role: "assistant", content: reply }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }));
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
    close: () => new Promise((r) => server.close(() => r())),
  };
}
