// "Sign in with NEAR" demo on plain node:http.   npx tsx example.ts   then open http://localhost:8790
// Env: PORT (8790), NETWORK (testnet), RECIPIENT (default: localhost:<port>). Bundles example-browser.ts with
// esbuild on start, using the shims wallet libraries need in a browser.
import { createServer } from "node:http";
import { build } from "esbuild";
import { createChallenge, statusFor, verifySignedMessage, type VerifyInput } from "./src/index.js";

const port = Number(process.env.PORT ?? 8790);
const network = process.env.NETWORK === "mainnet" ? "mainnet" : "testnet";
const recipient = process.env.RECIPIENT ?? `localhost:${port}`; // what wallets sign for: your host, from config

const bundle = await build({
  entryPoints: ["example-browser.ts"], bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", minify: true, logLevel: "warning",
  alias: { util: "./shims/util.js", crypto: "./shims/crypto.js", http: "./shims/empty.js", https: "./shims/empty.js" },
  inject: ["./shims/process.js"], define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
});
const js = bundle.outputFiles[0]!.text;
const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in with NEAR</title><link rel="stylesheet" href="/wallet-login.css"></head>
<body style="font-family:system-ui;max-width:480px;margin:48px auto;padding:0 16px">
<h1>Sign in with NEAR (${network})</h1><button id="go" style="font-size:17px;padding:12px 20px">Sign in with your wallet</button>
<p id="out"></p><script type="module" src="/app.js"></script></body></html>`;

const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  const json = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (path === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(page); }
  if (path === "/app.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(js); }
  if (path === "/wallet-login.css") { const { readFile } = await import("node:fs/promises"); res.writeHead(200, { "content-type": "text/css" }); return res.end(await readFile("wallet-login.css")); }
  if (path === "/challenge") return json(200, createChallenge({ recipient }));
  if (path === "/verify" && req.method === "POST") {
    let body = "";
    for await (const c of req) body += c;
    const input = JSON.parse(body || "{}") as VerifyInput;
    const r = await verifySignedMessage(input, { recipient, network });
    console.log("verify", input.accountId, r);
    // A real app sets a session cookie here.
    return json(statusFor(r), r);
  }
  json(404, { error: "not found" });
});
server.listen(port, () => console.log(`open http://localhost:${port}  (recipient ${recipient}, ${network})`));
