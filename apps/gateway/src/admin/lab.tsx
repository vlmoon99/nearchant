// Admin image lab (owner only — served on a separate port bound to the tailnet, never through the public tunnel).
// Upload a product photo + prompt → render it with several Comfy Cloud models side by side → rate → pick the default.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import type { FC } from "hono/jsx";
import { desc, eq } from "drizzle-orm";
import { schema, type Db } from "@nearchant/db";
import { ComfyCloud, ComfyError, fillWorkflow, type LabVariant } from "./comfy.js";

export interface LabDeps { db: Db; comfy: ComfyCloud | null; variants: LabVariant[]; workflows: Record<string, unknown>; mediaDir: string }

const Page: FC<{ variants: LabVariant[]; chosen: string | null; enabled: boolean }> = ({ variants, chosen, enabled }) => (
  <html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Image lab · Nearchant admin</title>
    <link rel="stylesheet" href="/lab.css" /></head>
    <body><main>
      <h1>Image lab <small>admin · tailnet only</small></h1>
      <p class="muted">Compare image models on Comfy Cloud with a real product photo. The model you mark <b>Use in production</b> becomes the default for post pictures. {enabled ? "" : <b class="err">COMFY_API_KEY is not set — runs are disabled.</b>}</p>
      <form id="run" class="card">
        <label>Product photo <input type="file" name="photo" accept="image/*" /></label>
        <label>What should the picture show?<textarea name="prompt" rows={3}>The same product worn by a person on a sunny city street in autumn, soft natural light, lifestyle photo for Instagram</textarea></label>
        <fieldset><legend>Models</legend>{variants.map((v) => <label class="chk"><input type="checkbox" name="variant" value={v.id} checked />{v.label}{v.id === chosen ? " ★ production" : ""}</label>)}</fieldset>
        <label>Size <select name="size"><option value="1024x1280">1024×1280 (post)</option><option value="1024x1024">1024×1024</option><option value="768x1344">768×1344 (story)</option></select></label>
        <button disabled={!enabled}>Run on Comfy Cloud</button> <output id="out"></output>
      </form>
      <section id="results"></section>
    </main><script src="/lab.js"></script></body></html>
);

const CSS = `body{font-family:Inter,system-ui,sans-serif;margin:0;background:#f5f5f7;color:#1d1d1f}main{max-width:1280px;margin:0 auto;padding:24px}
h1 small{font-size:14px;color:#6e6e73;font-weight:500}.muted{color:#6e6e73}.err{color:#ff3b30}.card{background:#fff;border-radius:16px;padding:20px;display:grid;gap:12px;margin-bottom:20px}
textarea,select,input[type=file]{font:inherit;padding:10px;border:1px solid #d2d2d7;border-radius:12px;width:100%;box-sizing:border-box}label{display:grid;gap:6px;font-size:13px;font-weight:600}
.chk{display:flex;gap:8px;align-items:center;font-weight:500}fieldset{border:0;padding:0;display:grid;gap:6px}button{background:#007aff;color:#fff;border:0;border-radius:999px;padding:11px 20px;font-weight:600;font-size:15px;cursor:pointer;width:fit-content}
button:disabled{opacity:.5}.batch{margin:24px 0}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px}.run{background:#fff;border-radius:16px;padding:12px;display:grid;gap:8px}
.run img{width:100%;border-radius:12px;background:#e5e5ea;aspect-ratio:4/5;object-fit:cover}.run .meta{font-size:12px;color:#6e6e73}.row{display:flex;gap:6px;flex-wrap:wrap}.row button{padding:6px 12px;font-size:13px;background:#f5f5f7;color:#1d1d1f}.row button.on{background:#1d1d1f;color:#fff}`;

const JS = `const $=s=>document.querySelector(s);
async function load(){const r=await fetch('/api/runs').then(x=>x.json());const by={};for(const x of r.runs)(by[x.batchId]??=[]).push(x);
$('#results').innerHTML=Object.entries(by).map(([b,rs])=>'<div class="batch"><div class="meta">'+new Date(rs[0].createdAt).toLocaleString()+' — '+rs[0].prompt.replace(/</g,'&lt;')+'</div><div class="grid">'+rs.map(x=>'<div class="run">'+(x.outputKey?'<img src="/out/'+x.id+'">':'<img alt="">')+'<b>'+x.label+'</b><span class="meta">'+x.status+(x.elapsedMs?' · '+(x.elapsedMs/1000).toFixed(1)+' s':'')+(x.error?' · '+x.error.replace(/</g,'&lt;'):'')+'</span>'+(x.outputKey?'<div class="row">'+[[-1,'👎'],[1,'👍'],[2,'⭐ best']].map(([v,l])=>'<button data-rate="'+x.id+'" data-v="'+v+'" class="'+(x.rating==v?'on':'')+'">'+l+'</button>').join('')+'<button data-use="'+x.variant+'">Use in production</button></div>':'')+'</div>').join('')+'</div></div>').join('');
document.querySelectorAll('[data-rate]').forEach(b=>b.onclick=async()=>{await fetch('/api/runs/'+b.dataset.rate+'/rate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({rating:Number(b.dataset.v)})});load()});
document.querySelectorAll('[data-use]').forEach(b=>b.onclick=async()=>{await fetch('/api/default',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({variant:b.dataset.use})});location.reload()});
if(r.runs.some(x=>x.status==='queued'||x.status==='running'))setTimeout(load,3000)}
$('#run').onsubmit=async e=>{e.preventDefault();const fd=new FormData(e.target);$('#out').textContent='Starting…';const r=await fetch('/api/runs',{method:'POST',body:fd});const j=await r.json();$('#out').textContent=r.ok?'Running '+j.runs+' renders…':j.error;load()};load();`;

export function labApp(d: LabDeps): Hono {
  const app = new Hono();
  const byId = new Map(d.variants.map((v) => [v.id, v]));
  const queue: (() => Promise<void>)[] = [];
  let active = 0;
  const pump = () => { while (active < 2 && queue.length) { const job = queue.shift()!; active++; void job().finally(() => { active--; pump(); }); } };

  app.get("/lab.css", (c) => c.body(CSS, 200, { "content-type": "text/css" }));
  app.get("/lab.js", (c) => c.body(JS, 200, { "content-type": "text/javascript" }));
  app.get("/", async (c) => {
    const chosen = (await d.db.select().from(schema.settings).where(eq(schema.settings.key, "image_variant")))[0]?.value as string | undefined;
    return c.html(<Page variants={d.variants} chosen={chosen ?? null} enabled={!!d.comfy} />);
  });
  app.get("/api/runs", async (c) => {
    const rows = await d.db.select().from(schema.labRuns).orderBy(desc(schema.labRuns.createdAt)).limit(120);
    return c.json({ runs: rows.map((r) => ({ ...r, label: byId.get(r.variant)?.label ?? r.variant })) });
  });
  app.get("/out/:id", async (c) => {
    const r = (await d.db.select().from(schema.labRuns).where(eq(schema.labRuns.id, c.req.param("id"))))[0];
    const bytes = r?.outputKey ? await readFile(join(d.mediaDir, r.outputKey)).catch(() => null) : null;
    return bytes ? c.body(bytes, 200, { "content-type": "image/png" }) : c.notFound();
  });
  app.post("/api/runs/:id/rate", async (c) => {
    const rating = Number(((await c.req.json().catch(() => ({}))) as { rating?: number }).rating);
    if (![-1, 0, 1, 2].includes(rating)) return c.json({ error: "rating -1..2" }, 400);
    await d.db.update(schema.labRuns).set({ rating }).where(eq(schema.labRuns.id, c.req.param("id")));
    return c.json({ ok: true });
  });
  app.post("/api/default", async (c) => {
    const variant = String(((await c.req.json().catch(() => ({}))) as { variant?: string }).variant ?? "");
    if (!byId.has(variant)) return c.json({ error: "unknown variant" }, 400);
    await d.db.insert(schema.settings).values({ key: "image_variant", value: variant }).onConflictDoUpdate({ target: schema.settings.key, set: { value: variant, updatedAt: new Date() } });
    return c.json({ ok: true });
  });
  app.post("/api/runs", async (c) => {
    if (!d.comfy) return c.json({ error: "COMFY_API_KEY is not set" }, 503);
    const form = await c.req.parseBody({ all: true });
    const prompt = String(form.prompt ?? "").trim().slice(0, 1000);
    const chosen = ([] as unknown[]).concat(form.variant ?? []).map(String).filter((v) => byId.has(v));
    const [w, h] = String(form.size ?? "1024x1280").split("x").map(Number) as [number, number];
    if (!prompt || !chosen.length) return c.json({ error: "prompt and at least one model" }, 400);
    const photo = form.photo instanceof File && form.photo.size ? Buffer.from(await form.photo.arrayBuffer()) : null;
    if (chosen.some((v) => byId.get(v)!.needs_photo) && !photo) return c.json({ error: "add a product photo for the edit models" }, 400);
    const batchId = `lab-${randomUUID().slice(0, 8)}`;
    await mkdir(join(d.mediaDir, "_lab"), { recursive: true });
    let photoKey: string | null = null, ref: string | undefined;
    if (photo) { photoKey = `_lab/${batchId}-in.png`; await writeFile(join(d.mediaDir, photoKey), photo); ref = await d.comfy.upload(photo, `${batchId}.png`); }
    const seed = Math.floor(Math.random() * 2 ** 31);
    for (const vid of chosen) {
      const v = byId.get(vid)!, id = `${batchId}-${vid}`;
      await d.db.insert(schema.labRuns).values({ id, batchId, variant: vid, prompt, photoKey });
      queue.push(async () => {
        const t0 = Date.now();
        await d.db.update(schema.labRuns).set({ status: "running" }).where(eq(schema.labRuns.id, id));
        try {
          const wf = fillWorkflow(d.workflows[v.workflow] as never, { prompt, ref, seed, width: w, height: h, set: v.set });
          const png = await d.comfy!.run(wf);
          const key = `_lab/${id}.png`;
          await writeFile(join(d.mediaDir, key), png);
          await d.db.update(schema.labRuns).set({ status: "done", outputKey: key, elapsedMs: Date.now() - t0 }).where(eq(schema.labRuns.id, id));
        } catch (e) {
          await d.db.update(schema.labRuns).set({ status: "failed", error: (e as Error).message.slice(0, 300), elapsedMs: Date.now() - t0 }).where(eq(schema.labRuns.id, id));
          if (e instanceof ComfyError && e.status === 402) queue.length = 0; // out of credits: stop the rest
        }
      });
    }
    pump();
    return c.json({ batchId, runs: chosen.length }, 202);
  });
  return app;
}
