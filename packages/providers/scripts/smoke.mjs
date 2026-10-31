// Live smoke test: one private chat via the configured route, one forced to NEAR AI, one embedding.
//   NEARAI_API_KEY=… NC_LOCAL_LLM_KEY=… node scripts/smoke.mjs ../../config/providers.yaml
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { Router } from "../dist/index.js";

const config = parse(readFileSync(process.argv[2] ?? "../../config/providers.yaml", "utf8"));
const r = Router.fromConfig(config);
const found = await r.discover();
for (const [id, m] of Object.entries(found)) console.log(`discover ${id}:`, Array.isArray(m) ? `${m.length} models` : m.error);

const ask = (extra = {}) => r.call({ capability: "chat", dataClass: "private",
  input: { messages: [{ role: "user", content: "In one short sentence: what is a pitch deck?" }], max_tokens: 60 }, ...extra });
for (const [label, req] of [["route", {}], ["nearai-glm", { endpoints: ["nearai"], model: "z-ai/glm-5.3-flash" }]]) {
  const e = await ask(req);
  console.log(`${label}: ${e.endpointId}/${e.model} ${e.latencyMs}ms tier=${e.privacyTier} attest=${e.attestation?.reportHash?.slice(0, 12) ?? "-"}`);
  console.log("   ", JSON.stringify(e.output.message.content ?? e.output.message).slice(0, 160));
}
const emb = await r.call({ capability: "embed", dataClass: "private", input: { input: ["handmade ceramics"] } });
console.log(`embed: ${emb.endpointId}/${emb.model} dim=${emb.output.dim}`);
