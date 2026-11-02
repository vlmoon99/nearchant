// Comfy Cloud client (ported from inference_system/services/image/app.py): upload → prompt → poll → signed file.
// Used by the admin image lab to compare models on the owner's Comfy Cloud credits.

export interface LabVariant { id: string; label: string; workflow: string; needs_photo: boolean; set?: Record<string, string | number>; output?: "image" | "video" }

export class ComfyError extends Error {
  constructor(message: string, public readonly status?: number) { super(message); }
}

const PLAIN: Record<number, string> = { 401: "the Comfy Cloud key is wrong", 402: "Comfy Cloud is out of credits", 429: "the Comfy Cloud subscription is not active" };

/** Fills placeholders and applies "<node>.<input>" overrides; returns a new graph (the template is untouched). */
export function fillWorkflow(template: Record<string, { class_type: string; inputs: Record<string, unknown> }>, v: { prompt: string; ref?: string; seed: number; width: number; height: number; set?: Record<string, string | number> }) {
  const wf = JSON.parse(JSON.stringify(template)) as typeof template;
  const map: Record<string, unknown> = { __PROMPT__: v.prompt, __REF__: v.ref ?? "", __SEED__: v.seed, __WIDTH__: v.width, __HEIGHT__: v.height };
  for (const node of Object.values(wf)) {
    for (const [k, val] of Object.entries(node.inputs)) if (typeof val === "string" && val in map) node.inputs[k] = map[val];
  }
  for (const [path, val] of Object.entries(v.set ?? {})) {
    const [id, input] = path.split(".");
    if (!id || !input || !wf[id]) throw new Error(`override ${path}: no node ${id}`);
    wf[id]!.inputs[input] = val;
  }
  return wf;
}

export class ComfyCloud {
  constructor(private key: string, private base = "https://cloud.comfy.org/api", private fetchFn: typeof fetch = fetch) {}
  private h() { return { "X-API-Key": this.key }; }

  async upload(bytes: Uint8Array, name: string): Promise<string> {
    const fd = new FormData();
    fd.append("image", new Blob([new Uint8Array(bytes)], { type: "image/png" }), name);
    fd.append("overwrite", "true"); fd.append("type", "input");
    const r = await this.fetchFn(`${this.base}/upload/image`, { method: "POST", headers: this.h(), body: fd, signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new ComfyError(`upload: ${PLAIN[r.status] ?? `HTTP ${r.status}`}`, r.status);
    const j = (await r.json()) as { name: string; subfolder?: string };
    return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
  }

  /** Runs a graph to completion and returns the first output image (≤10 min). */
  async run(wf: unknown, onStatus?: (s: string) => void): Promise<Uint8Array> {
    const r = await this.fetchFn(`${this.base}/prompt`, { method: "POST", headers: { ...this.h(), "content-type": "application/json" }, body: JSON.stringify({ prompt: wf }), signal: AbortSignal.timeout(60_000) });
    const j = (await r.json().catch(() => ({}))) as { prompt_id?: string; error?: unknown };
    if (!r.ok || !j.prompt_id) throw new ComfyError(`prompt: ${PLAIN[r.status] ?? `HTTP ${r.status}`} ${JSON.stringify(j.error ?? j).slice(0, 300)}`, r.status);
    const pid = j.prompt_id;
    for (let i = 0; i < 300; i++) {
      await new Promise((res) => setTimeout(res, 2000));
      const s = await this.fetchFn(`${this.base}/job/${pid}/status`, { headers: this.h(), signal: AbortSignal.timeout(30_000) }).then((x) => x.json() as Promise<{ status?: string }>).catch(() => ({} as { status?: string }));
      if (s.status) onStatus?.(s.status);
      if (!s.status || !["success", "error", "non_retryable_error", "lost", "cancelled"].includes(s.status)) continue;
      if (s.status !== "success") throw new ComfyError(`job ended as ${s.status}`);
      type File = { filename: string; subfolder?: string; type?: string };
      const job = (await (await this.fetchFn(`${this.base}/jobs/${pid}`, { headers: this.h(), signal: AbortSignal.timeout(30_000) })).json()) as { outputs?: Record<string, Record<string, unknown>> };
      // Images, animated WEBP/WEBM and videos are all listed as files under some output key.
      const im = Object.values(job.outputs ?? {}).flatMap((o) => Object.values(o).filter(Array.isArray).flat() as File[]).find((f) => f && typeof f.filename === "string");
      if (!im) throw new ComfyError("job has no picture");
      const q = new URLSearchParams({ filename: im.filename, subfolder: im.subfolder ?? "", type: im.type ?? "output" });
      const v = await this.fetchFn(`${this.base}/view?${q}`, { headers: this.h(), redirect: "manual", signal: AbortSignal.timeout(30_000) });
      const loc = v.headers.get("location");
      if (!loc) throw new ComfyError(`view: HTTP ${v.status}`, v.status);
      const f = await this.fetchFn(loc, { signal: AbortSignal.timeout(120_000) }); // signed link: no key to the storage host
      if (!f.ok) throw new ComfyError(`download: HTTP ${f.status}`);
      return new Uint8Array(await f.arrayBuffer());
    }
    throw new ComfyError("timed out after 10 minutes");
  }
}
