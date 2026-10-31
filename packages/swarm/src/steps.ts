import { createHash } from "node:crypto";
import type { ResultEnvelope } from "@nearchant/contracts";
import { block, type Asker, type ModelRouter } from "./agent.js";
import type { AgentEnv } from "./env.js";

export const PIPELINE = ["brief", "research", "council", "write", "design", "review", "render", "deliver"] as const;
export type Step = (typeof PIPELINE)[number];

export interface Brief {
  refuse: string | null;
  language: string;
  company: string | null;
  product: string;
  audience: string;
  goal: string;
  tone: string;
  facts_from_buyer: string[];
  must_include: string[];
  avoid: string[];
  open_questions: string[];
}
export interface Finding { id?: string; claim: string; source_url: string | null; source_title: string; confidence: string }
export interface Dossier { summary: string; findings: (Finding & { id: string })[]; gaps: string[] }
export interface Strategy { slides: { n: number; title: string; key_message: string; bullets: string[]; evidence: string[]; visual: string | null }[]; tone: string; minority_report: string }
export interface Review { passed: boolean; score: number; issues: { slide: number; problem: string; fix: string }[]; untraced_claims: string[] }
export interface Rendered { files: { kind: "pdf" | "pptx" | "html" | "md"; name: string; sha256: string; url: string }[] }

export interface SearchResult { title: string; url: string; snippet: string }

export interface StepContext {
  orderId: string;
  brief: string;
  env: AgentEnv;
  router: ModelRouter;
  ask: Asker;
  /** Earlier artifacts by step. */
  done: Partial<Record<Step, any>>;
  search?: (query: string) => Promise<SearchResult[]>;
  media: { put(orderId: string, name: string, bytes: Uint8Array): Promise<string> };
  render: (orderId: string, markdown: string) => Promise<Rendered>;
  deliver: (orderId: string, proof: ProofEntry) => Promise<void>;
  track: (e: ResultEnvelope, role: string) => Promise<void>;
  /** Report hash of the latest TEE attestation among this job's envelopes (null if all calls were local). */
  attestationRef: () => Promise<string | null>;
  log?: (msg: string) => void;
}

export interface ProofEntry {
  task_id: string;
  order_id: string;
  brief_hash: string;
  producer: string;
  output_hash: string;
  attestation_ref: string | null;
  review: { passed: boolean; reviewer_hash: string };
}

/** Thrown when a step decides the job must stop (refused brief, failed review twice). */
export class JobStop extends Error {
  constructor(public readonly reason: string, public readonly kind: "refused" | "failed_review") {
    super(reason);
  }
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** `[f3]` ids cited in a deck. */
export function citedIds(md: string): string[] {
  return [...new Set([...md.matchAll(/\[(f\d+)\]/g)].map((m) => m[1]!))];
}

/** Content slides = slides after the front matter, excluding the title slide and "Sources". */
export function slideCount(md: string): number {
  const body = md.replace(/^---\n[\s\S]*?\n---\n/, "");
  return body.split(/\n---\n/).filter((s) => s.trim() && !/^##\s*Sources/m.test(s)).length - 1;
}

/** Deterministic checks the model reviewer can't talk its way around. */
export function checkDeck(md: string, dossier: Dossier): string[] {
  const problems: string[] = [];
  if (!/^---\n[\s\S]*?marp:\s*true[\s\S]*?\n---/.test(md)) problems.push("missing Marp front matter");
  const ids = new Set(dossier.findings.map((f) => f.id));
  const unknown = citedIds(md).filter((id) => !ids.has(id));
  if (unknown.length) problems.push(`cites findings that don't exist: ${unknown.join(", ")}`);
  if (slideCount(md) < 6) problems.push(`only ${slideCount(md)} content slides`);
  if (/lorem ipsum|\[your [a-z ]+\]|TODO|TBD/i.test(md)) problems.push("placeholder text");
  return problems;
}

/** Keeps the first ```markdown fence if the model wrapped the deck in one; makes sure front matter exists. */
export function cleanDeck(md: string): string {
  const fenced = md.match(/```(?:markdown|md)?\s*\n([\s\S]*?)```/);
  let d = (fenced ? fenced[1]! : md).trim();
  if (!d.startsWith("---")) d = `---\nmarp: true\npaginate: true\ntheme: default\n---\n\n${d}`;
  return d + "\n";
}

export const STEPS: Record<Step, (c: StepContext) => Promise<unknown>> = {
  async brief(c) {
    const b = await c.ask<Brief>("brief-analyst", block("brief", c.brief));
    if (b.refuse) throw new JobStop(b.refuse, "refused");
    return b;
  },

  async research(c) {
    const brief = c.done.brief as Brief;
    const scouts = await Promise.all(
      c.env.research.scouts.map(async (s) => {
        const query = `${brief.product} ${s.focus}`;
        const results = c.search ? await c.search(query).catch(() => []) : [];
        const user = [
          `Focus: ${s.focus} — ${s.ask}`,
          block("brief", brief),
          results.length ? block("findings", results.slice(0, 8)) : "No search results: use what you know and mark source_title 'model knowledge'.",
        ].join("\n\n");
        const r = await c.ask<{ findings: Finding[] }>("scout", user);
        return { focus: s.focus, findings: r.findings ?? [], searched: results.length };
      }),
    );
    const dossier = await c.ask<Dossier>("dossier-analyst", [block("brief", brief), block("findings", scouts)].join("\n\n"));
    dossier.findings = (dossier.findings ?? []).map((f, i) => ({ ...f, id: f.id && /^f\d+$/.test(f.id) ? f.id : `f${i + 1}` }));
    return { scouts, dossier };
  },

  async council(c) {
    const brief = c.done.brief as Brief;
    const { dossier } = c.done.research as { dossier: Dossier };
    const base = [block("brief", brief), block("dossier", dossier)].join("\n\n");
    const advocate = await c.ask<{ arc: unknown[]; why: string }>("advocate", base);
    const [skeptic, persona] = await Promise.all([
      c.ask<{ objections: unknown[] }>("skeptic", `${base}\n\n${block("draft", advocate)}`),
      c.ask<{ wants: string[] }>("buyer-persona", `${block("brief", brief)}\n\n${block("draft", advocate)}`),
    ]);
    const strategy = await c.ask<Strategy>("judge", [base, block("draft", { advocate, skeptic, audience: persona })].join("\n\n"));
    return { advocate, skeptic, persona, strategy };
  },

  async write(c) {
    const brief = c.done.brief as Brief;
    const { dossier } = c.done.research as { dossier: Dossier };
    const { strategy } = c.done.council as { strategy: Strategy };
    const md = cleanDeck(await c.ask<string>("copywriter", [block("brief", brief), block("dossier", dossier), block("draft", strategy)].join("\n\n")));
    return { markdown: md, problems: checkDeck(md, dossier) };
  },

  async design(c) {
    const brief = c.done.brief as Brief;
    let md = (c.done.write as { markdown: string }).markdown;
    try {
      const { prompt } = await c.ask<{ prompt: string }>("image-designer", block("brief", { product: brief.product, audience: brief.audience, tone: brief.tone }));
      const e = await c.router.call({ capability: "image.generate", dataClass: "private", input: { prompt, n: 1, size: "1024x1024" } });
      await c.track(e, "image-designer");
      const b64 = (e.output as { images?: { b64?: string }[] }).images?.[0]?.b64;
      if (!b64) return { markdown: md, image: null };
      const url = await c.media.put(c.orderId, "cover.png", Buffer.from(b64, "base64"));
      // Background image on the right of the title slide (first slide after the front matter).
      md = md.replace(/(^---\n[\s\S]*?\n---\n\s*\n?)(#)/, `$1![bg right:40%](${url})\n\n$2`);
      return { markdown: md, image: { url, prompt } };
    } catch (e) {
      c.log?.(`design: no cover image (${(e as Error).message})`);
      return { markdown: md, image: null };
    }
  },

  async review(c) {
    const brief = c.done.brief as Brief;
    const { dossier } = c.done.research as { dossier: Dossier };
    const { strategy } = c.done.council as { strategy: Strategy };
    let md = (c.done.design as { markdown: string }).markdown;
    const rounds: { review: Review; problems: string[] }[] = [];
    for (let round = 0; round < 2; round++) {
      const problems = checkDeck(md, dossier);
      const review = await c.ask<Review>("reviewer", [block("brief", brief), block("dossier", dossier), block("draft", md)].join("\n\n"));
      const passed = review.passed === true && problems.length === 0;
      rounds.push({ review: { ...review, passed }, problems });
      if (passed) return { markdown: md, passed: true, rounds };
      if (round === 1) break;
      // One rework: the copywriter gets the issues and rewrites (the cover image line is kept).
      const cover = md.match(/!\[bg right:40%\]\([^)]+\)\n\n/)?.[0] ?? "";
      const fix = { reviewer_issues: review.issues, untraced_claims: review.untraced_claims, checks: problems };
      // Edit the existing draft rather than starting over, so fixed slides don't regress.
      let next = cleanDeck(await c.ask<string>("copywriter", [block("brief", brief), block("dossier", dossier), block("draft", md), block("findings", fix), "Edit the deck in <draft>: fix every issue listed in <findings>, keep everything else, and return the whole corrected deck."].join("\n\n")));
      if (cover) next = next.replace(/(^---\n[\s\S]*?\n---\n\s*\n?)(#)/, `$1${cover}$2`);
      md = next;
    }
    throw new JobStop(`deck failed review twice: ${JSON.stringify(rounds.at(-1))}`.slice(0, 1000), "failed_review");
  },

  async render(c) {
    const { markdown } = c.done.review as { markdown: string };
    return c.render(c.orderId, markdown);
  },

  async deliver(c) {
    const brief = c.done.brief as Brief;
    const review = c.done.review as { markdown: string; rounds: unknown[] };
    const proof: ProofEntry = {
      task_id: `deck:${c.orderId}`,
      order_id: c.orderId,
      brief_hash: sha(JSON.stringify(brief)),
      producer: `swarm:${c.env.name}@${c.env.version}`,
      output_hash: sha(review.markdown),
      attestation_ref: await c.attestationRef(),
      review: { passed: true, reviewer_hash: sha(JSON.stringify(review.rounds)) },
    };
    await c.deliver(c.orderId, proof);
    return { proof };
  },
};

export function nextStep(step: Step): Step | null {
  const i = PIPELINE.indexOf(step);
  return i >= 0 && i < PIPELINE.length - 1 ? PIPELINE[i + 1]! : null;
}
