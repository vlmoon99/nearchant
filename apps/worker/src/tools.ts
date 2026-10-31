import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Rendered, SearchResult } from "@nearchant/swarm";

/** Web search for scouts through a SearXNG instance (JSON API). Results are data, never instructions. */
export function searxng(baseUrl: string) {
  return async (q: string): Promise<SearchResult[]> => {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/search?format=json&q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`searxng ${res.status}`);
    const j = (await res.json()) as { results?: { title: string; url: string; content?: string }[] };
    return (j.results ?? []).filter((r) => /^https?:\/\//.test(r.url)).slice(0, 10).map((r) => ({ title: r.title, url: r.url, snippet: (r.content ?? "").slice(0, 400) }));
  };
}

/** Files under `<dir>/<orderId>/<name>`, served by the gateway at `<publicBase>/<orderId>/<name>`. */
export function localMedia(dir: string, publicBase: string) {
  return {
    async put(orderId: string, name: string, bytes: Uint8Array): Promise<string> {
      if (!/^[A-Za-z0-9._-]+$/.test(orderId) || !/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("bad media path");
      mkdirSync(join(dir, orderId), { recursive: true });
      writeFileSync(join(dir, orderId, name), bytes);
      return `${publicBase.replace(/\/+$/, "")}/${orderId}/${name}`;
    },
    path: (orderId: string, name: string) => join(dir, orderId, name),
  };
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/**
 * Renders through a `marp --server` container that sees the same media dir (deploy/local/compose.yaml):
 * GET <renderer>/<orderId>/deck.md?pdf|pptx returns the converted file. Local images resolve relative to the deck.
 */
export function marpServerRender(rendererUrl: string, media: ReturnType<typeof localMedia>) {
  return async (orderId: string, markdown: string): Promise<Rendered> => {
    // The deck references its cover as a URL; inside the renderer it must be the sibling file.
    const local = markdown.replace(/\]\([^)]*\/(cover\.png)\)/g, "]($1)");
    const mdUrl = await media.put(orderId, "deck.md", Buffer.from(local));
    const files: Rendered["files"] = [{ kind: "md", name: "deck.md", sha256: sha(Buffer.from(local)), url: mdUrl }];
    for (const kind of ["pdf", "pptx", "html"] as const) {
      const q = kind === "html" ? "" : `?${kind}`;
      const res = await fetch(`${rendererUrl.replace(/\/+$/, "")}/${orderId}/deck.md${q}`, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`render ${kind}: ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const name = `deck.${kind}`;
      files.push({ kind, name, sha256: sha(bytes), url: await media.put(orderId, name, bytes) });
    }
    return { files };
  };
}
