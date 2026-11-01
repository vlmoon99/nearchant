// Worker tasks for the content store (ADR 0018): analyse a business, find opportunities. Posts come in step 6.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Task } from "graphile-worker";
import sharp from "sharp";
import type { ContentStore, Envelopes } from "@nearchant/db";
import { analyzeBusiness, factsFromProfile, findOpportunities, makeAsker, type AgentEnv, type ModelRouter, type SearchResult, type StyleProfile } from "@nearchant/swarm";

export interface ContentTaskDeps {
  content: ContentStore;
  envelopes: Envelopes;
  router: ModelRouter;
  env: AgentEnv;
  mediaDir: string;
  /** NEAR account that pays for the AI usage of a store (billing, flow 2). */
  accountOf: (handle: string) => string;
  search?: (q: string) => Promise<SearchResult[]>;
  decimals: number;
  log: (m: string) => void;
}

/** A photo as a JPEG data URL, at most 1024 px on the long side (vision models bill by pixels). */
export async function photoDataUrl(path: string): Promise<string> {
  const jpg = await sharp(await readFile(path)).rotate().resize(1024, 1024, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  return `data:image/jpeg;base64,${jpg.toString("base64")}`;
}

export function makeContentTasks(d: ContentTaskDeps): Record<string, Task> {
  const askFor = (handle: string, step: string) => makeAsker(d.env, d.router, async (e) => { await d.envelopes.add(`content:${handle}:${step}`, step, d.accountOf(handle), e); });

  const analyzeBusinessTask: Task = async (payload, helpers) => {
    const { handle } = payload as { handle: string };
    const b = await d.content.getBusiness(handle);
    if (!b) throw new Error(`no business ${handle}`);
    try {
      const photos = (await d.content.listMedia(handle, "photo")).slice(0, 8);
      const urls = await Promise.all(photos.map((m) => photoDataUrl(join(d.mediaDir, m.key))));
      const profile = await analyzeBusiness(askFor(handle, "analyze"), { name: b.name, kind: b.kind, description: b.description, links: b.links as string[] }, urls);
      // Keep the owner's own edits (e.g. wishes) across a new analysis.
      const prev = (await d.content.getProfile(handle))?.data as Partial<StyleProfile> | undefined;
      await d.content.setProfile(handle, { data: { ...profile, ...(prev?.wishes ? { wishes: prev.wishes } : {}) }, status: "finding" });
      for (const f of factsFromProfile(profile)) await d.content.addFact(handle, f);
      await d.content.addFact(handle, { title: "Comparing with similar stores", detail: "Prices, trends, what sells this month" });
      await helpers.addJob("find_opportunities", { handle }, { jobKey: `opportunities:${handle}`, maxAttempts: 2 });
      d.log(`analyze ${handle}: ${profile.products.length} products`);
    } catch (e) {
      await d.content.setProfile(handle, { status: "failed", error: (e as Error).message.slice(0, 300) });
      throw e;
    }
  };

  const findOpportunitiesTask: Task = async (payload) => {
    const { handle } = payload as { handle: string };
    const profile = (await d.content.getProfile(handle))?.data as StyleProfile | undefined;
    if (!profile?.products) throw new Error(`no profile for ${handle}`);
    const items = (await d.content.listItems(handle)).map((i) => ({ title: i.title, price: `${Number(i.priceUnits) / 10 ** d.decimals} USD` }));
    try {
      const { opportunities, searched } = await findOpportunities(askFor(handle, "opportunities"), profile, items, d.search);
      await d.content.replaceOpportunities(handle, opportunities.map((o) => ({
        kind: o.kind, title: o.title, why: o.why, estimateUnits: String(BigInt(o.estimate_usd_month) * 10n ** BigInt(d.decimals)),
        data: { action: o.action, confidence: o.confidence, source: o.source },
      })));
      await d.content.setProfile(handle, { status: "ready" });
      d.log(`opportunities ${handle}: ${opportunities.length} (from ${searched} web results)`);
    } catch (e) {
      // The profile is still useful without opportunities: the owner can go on and make posts.
      await d.content.setProfile(handle, { status: "ready", error: `opportunities: ${(e as Error).message.slice(0, 200)}` });
      throw e;
    }
  };

  return { analyze_business: analyzeBusinessTask, find_opportunities: findOpportunitiesTask };
}
