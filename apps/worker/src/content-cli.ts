// The content-store story in one process (ADR 0018), for `make demo` and for recording it:
// product photos → analyze → opportunities → 3 post options with pictures → .media/demo-store/{index.html, …}.
//   live + record: RECORD_DIR=fixtures/replay/store NEARAI_API_KEY=… COMFY_API_KEY=… PROVIDERS_FILE=providers.mac.yaml node dist/content-cli.js
//   replay (no keys): REPLAY_DIR=fixtures/replay/store node dist/content-cli.js
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { ComfyCloud, fillWorkflow, type LabVariant } from "@nearchant/providers";
import { analyzeBusiness, factsFromProfile, findOpportunities, loadAgentEnv, makeAsker, writePostOptions } from "@nearchant/swarm";
import { makeRouter } from "./router.js";
import { recordedSearch, searxng } from "./tools.js";
import { applyHeadline, headlineAss } from "./image-text.js";
import { pickAccent } from "./video-compose.js";

const root = resolve(import.meta.dirname, "../../..");
const fixture = process.env.RECORD_DIR ?? process.env.REPLAY_DIR ?? join(root, "fixtures/replay/store");
const out = join(process.env.MEDIA_DIR ?? join(root, ".media"), "demo-store");
mkdirSync(out, { recursive: true });
const meta = JSON.parse(readFileSync(join(fixture, "business.json"), "utf8")) as { name: string; kind: string; description: string; links: string[]; today: string };
const photoFiles = readdirSync(join(fixture, "photos")).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort();
// Original bytes (no re-encoding): the replay key must be identical on every machine.
const photos = photoFiles.map((f) => readFileSync(join(fixture, "photos", f)));
const dataUrls = photos.map((b, i) => `data:image/${photoFiles[i]!.endsWith(".png") ? "png" : "jpeg"};base64,${b.toString("base64")}`);

const router = await makeRouter(join(root, "config", process.env.PROVIDERS_FILE ?? "providers.mac.yaml"));
const env = loadAgentEnv(join(root, "envs/content-store"));
let calls = 0;
const ask = makeAsker(env, router, async () => { calls++; });
const t0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

// Pictures: recorded from Comfy Cloud (lab default variant), replayed from the fixture by a key of prompt + photo.
const lab = parse(readFileSync(join(root, "config/image-lab.yaml"), "utf8")) as { variants: LabVariant[] };
const variant = lab.variants.find((v) => v.id === (process.env.IMAGE_VARIANT ?? "qie2511-l4"))!;
const comfy = process.env.RECORD_DIR && process.env.COMFY_API_KEY ? new ComfyCloud(process.env.COMFY_API_KEY) : null;
// A post without a product photo is painted from text (the edit model needs a photo).
const t2i = lab.variants.find((v) => v.id === "qi2512-l4")!;
async function picture(prompt: string, photoIdx: number | null): Promise<Buffer | null> {
  const v = photoIdx === null && variant.needs_photo ? t2i : variant;
  const key = createHash("sha256").update(`${v.id}\n${prompt}\n${photoIdx ?? "-"}`).digest("hex").slice(0, 32);
  const file = join(fixture, "images", `${key}.png`);
  if (existsSync(file)) return readFileSync(file);   // already recorded: keep it (lets a re-run fill only the gaps)
  if (!comfy) return null;
  const template = JSON.parse(readFileSync(join(root, "config/image-lab", v.workflow), "utf8"));
  const ref = photoIdx !== null ? await comfy.upload(photos[photoIdx]!, `demo-${photoIdx}.png`) : undefined;
  let png: Buffer | null = null;
  for (const seed of [42, 43, 44, 45]) {   // a Comfy Cloud job sometimes ends in a non-retryable error: a few more seeds, then skip
    try { png = Buffer.from(await comfy.run(fillWorkflow(template, { prompt, ref, seed, width: 1024, height: 1280, set: v.set }))); break; }
    catch (e) { log(`picture failed (seed ${seed}): ${(e as Error).message}`); }
  }
  if (!png) return null;
  mkdirSync(join(fixture, "images"), { recursive: true });
  writeFileSync(file, png);
  return png;
}

log(`${meta.name}: ${photos.length} photos`);
const profile = await analyzeBusiness(ask, meta, dataUrls);
for (const f of factsFromProfile(profile)) log(`found · ${f.title}: ${f.detail}`);
const search = process.env.RECORD_DIR && process.env.SEARXNG_URL ? recordedSearch(join(fixture, "search"), searxng(process.env.SEARXNG_URL)) : recordedSearch(join(fixture, "search"));
const { opportunities } = await findOpportunities(ask, profile, [], search);
for (const o of opportunities) log(`opportunity · ${o.kind}: ${o.title} (≈ +${o.estimate_usd_month} USD/mo)`);
const posts = await writePostOptions(ask, { profile, n: 3, photoCount: photos.length, opportunity: opportunities[0] ?? null, today: meta.today });
const rendered: { caption: string; hashtags: string[]; angle: string; image: string | null }[] = [];
for (const [i, p] of posts.entries()) {
  const png = await picture(p.image_prompt || p.angle, p.photo ? p.photo - 1 : null);
  if (png) {
    writeFileSync(join(out, `post-${i + 1}.png`), png);
    // The headline strip in our font + the brand colour (needs ffmpeg with libass — the Docker image has it).
    if (p.headline) {
      try {
        writeFileSync(join(out, `post-${i + 1}.ass`), headlineAss(p.headline, 1024, 1280, pickAccent(profile.brand_colors)));
        await applyHeadline({ input: join(out, `post-${i + 1}.png`), output: join(out, `post-${i + 1}-h.png`), ass: join(out, `post-${i + 1}.ass`), fontsDir: join(root, "assets/fonts") });
        writeFileSync(join(out, `post-${i + 1}.png`), readFileSync(join(out, `post-${i + 1}-h.png`)));
      } catch { /* plain picture */ }
    }
  }
  rendered.push({ caption: p.caption, hashtags: p.hashtags, angle: p.angle, image: png ? `post-${i + 1}.png` : null });
  log(`post ${i + 1} · ${p.angle}${png ? " · picture ✓" : " · no picture"}`);
}
photoFiles.forEach((f, i) => writeFileSync(join(out, `photo-${i + 1}${f.slice(f.lastIndexOf("."))}`), photos[i]!));

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
writeFileSync(join(out, "result.json"), JSON.stringify({ profile, opportunities, posts: rendered }, null, 1));
writeFileSync(join(out, "index.html"), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(meta.name)} · Nearchant demo</title>
<style>body{font-family:Inter,system-ui,sans-serif;max-width:1100px;margin:0 auto;padding:24px;color:#1d1d1f}.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px}.c{background:#f5f5f7;border-radius:16px;padding:14px}img{width:100%;border-radius:12px}.t{color:#007a4f;font-weight:600}</style>
<h1>${esc(profile.business_name)}</h1><p>${esc(profile.summary)}</p>
<h2>What the AI found</h2><ul>${factsFromProfile(profile).map((f) => `<li><b>${esc(f.title)}</b> — ${esc(f.detail)}</li>`).join("")}</ul>
<h2>Ways to sell more</h2><div class="g">${opportunities.map((o) => `<div class="c"><b>${esc(o.title)}</b><p>${esc(o.why)}</p><span class="t">≈ +${o.estimate_usd_month} USD/month (estimate)</span></div>`).join("")}</div>
<h2>Product photos → first posts</h2><div class="g">${photoFiles.map((_, i) => `<div class="c"><img src="photo-${i + 1}${photoFiles[i]!.slice(photoFiles[i]!.lastIndexOf("."))}"><span>Photo ${i + 1}</span></div>`).join("")}</div>
<div class="g" style="margin-top:16px">${rendered.map((p) => `<div class="c">${p.image ? `<img src="${p.image}">` : ""}<p>${esc(p.caption)}</p><small>${p.hashtags.map((h) => "#" + esc(h)).join(" ")}</small></div>`).join("")}</div>`);
log(`done — ${calls} model calls · open ${join(out, "index.html")}`);
