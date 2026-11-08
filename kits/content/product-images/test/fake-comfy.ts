// An in-memory Comfy Cloud / ComfyUI for tests: answers the endpoints the client uses and records every call.
export interface FakeComfyOptions {
  api?: "cloud" | "comfyui";
  /** Status answers in order before "success" (cloud) / completed (comfyui). */
  running?: number;
  /** Override a response for a path prefix, once per entry (then normal behaviour). */
  fail?: Record<string, (Response | Error)[]>;
  final?: "success" | "error";
  output?: Uint8Array;
}

export function fakeComfy(o: FakeComfyOptions = {}) {
  const api = o.api ?? "cloud";
  const calls: { method: string; url: string; headers: Record<string, string>; body?: unknown }[] = [];
  const queued: unknown[] = [];
  let polls = 0, n = 0;
  const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "content-type": "application/json" } });
  const f = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input), u = new URL(url), method = init.method ?? "GET";
    const headers = { ...(init.headers as Record<string, string> | undefined) };
    let body: unknown = init.body;
    if (typeof init.body === "string") body = JSON.parse(init.body);
    calls.push({ method, url, headers, body });
    for (const [prefix, list] of Object.entries(o.fail ?? {})) {
      if (u.pathname.startsWith(prefix) && list.length) { const r = list.shift()!; if (r instanceof Error) throw r; return r; }
    }
    if (u.host === "signed.example") return new Response(new Uint8Array(o.output ?? [1, 2, 3]));
    const p = u.pathname.replace(/^\/api/, "");
    if (p === "/upload/image") return json({ name: "photo.png", subfolder: "" });
    if (p === "/prompt") { queued.push((body as { prompt: unknown }).prompt); return json({ prompt_id: `p${++n}` }); }
    const done = polls++ >= (o.running ?? 0);
    const outputs = { "9": { images: [{ filename: "out.png", subfolder: "", type: "output" }] } };
    if (p.startsWith("/job/")) return json({ status: done ? (o.final ?? "success") : "in_progress" });
    if (p.startsWith("/jobs/")) return json({ outputs });
    if (p.startsWith("/history/")) {
      const id = p.split("/")[2]!;
      return json(done ? { [id]: { outputs, status: { completed: (o.final ?? "success") === "success", status_str: o.final ?? "success", messages: [] } } } : {});
    }
    if (p === "/view") {
      return api === "cloud" ? new Response(null, { status: 302, headers: { location: "https://signed.example/file?sig=1" } }) : new Response(new Uint8Array(o.output ?? [1, 2, 3]));
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetch: f, calls, queued };
}
