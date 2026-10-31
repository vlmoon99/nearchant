// Runs one deck job in-process with real models — no queue, no chain. For development and recording replays.
//   node dist/cli.js "<brief>"     env: NEARAI_API_KEY, NC_LOCAL_LLM_KEY, SEARXNG_URL, RENDERER_URL, MEDIA_DIR, RECORD_DIR
import { join, resolve } from "node:path";
import { loadAgentEnv, runPipeline, type JobDeps } from "@nearchant/swarm";
import { localMedia, marpServerRender, searxng } from "./tools.js";
import { makeRouter } from "./router.js";

const root = resolve(import.meta.dirname, "../../..");
const brief = process.argv.slice(2).join(" ") || "Seed pitch deck for BeanBox: a specialty coffee subscription in Kyiv, 18 EUR a month, 400 paying subscribers after 6 months, two founders (a roaster and a growth marketer), raising 300k EUR to open a second roastery.";
const orderId = process.env.ORDER_ID ?? `cli-${Date.now().toString(36)}`;
const router = await makeRouter(join(root, "config/providers.yaml"));
const media = localMedia(process.env.MEDIA_DIR ?? join(root, ".media"), process.env.MEDIA_PUBLIC ?? "/media");
const store = new Map<string, unknown>();
const t0 = Date.now();
let calls = 0;

const deps: JobDeps = {
  env: loadAgentEnv(join(root, "envs/deck-seller")),
  router,
  artifacts: {
    get: async <T,>(o: string, s: string) => (store.get(`${o}/${s}`) as T) ?? null,
    put: async (o, s, v) => (store.has(`${o}/${s}`) ? false : (store.set(`${o}/${s}`, v), true)),
    all: async (o) => Object.fromEntries([...store].filter(([k]) => k.startsWith(`${o}/`)).map(([k, v]) => [k.split("/")[1]!, v])),
  },
  record: async (_o, step, role, e) => {
    calls++;
    console.log(`  · ${step}/${role} → ${e.endpointId}/${e.model} ${e.latencyMs}ms${e.replayed ? " (replay)" : ""}`);
  },
  media,
  render: process.env.RENDERER_URL ? marpServerRender(process.env.RENDERER_URL, media) : async (o, md) => ({ files: [{ kind: "md", name: "deck.md", sha256: "", url: await media.put(o, "deck.md", Buffer.from(md)) }] }),
  deliver: async (_o, proof) => console.log("  · deliver (dry run) proof:", JSON.stringify(proof)),
  search: process.env.SEARXNG_URL ? searxng(process.env.SEARXNG_URL) : undefined,
  log: (m) => console.log(`  ${m}`),
};

console.log(`order ${orderId}`);
const out = await runPipeline(deps, orderId, brief);
console.log(`\n${JSON.stringify(out)} — ${calls} model calls in ${Math.round((Date.now() - t0) / 1000)}s`);
const review = store.get(`${orderId}/review`) as { rounds?: { review: { score: number } }[] } | undefined;
if (review?.rounds) console.log(`review scores: ${review.rounds.map((r) => r.review.score).join(" → ")}`);
console.log(`files in ${media.path(orderId, "")}`);
