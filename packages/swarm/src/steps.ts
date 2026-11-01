import { createHash } from "node:crypto";
import type { ResultEnvelope } from "@nearchant/contracts";
import { block, type Asker, type ModelRouter } from "./agent.js";
import type { AgentEnv } from "./env.js";

export const PIPELINE = ["brief", "research", "council", "factcheck", "write", "design", "review", "render", "deliver"] as const;
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
export interface ReviewIssue { slide: number; quote?: string; problem: string; fix: string }
export interface Review { blocking: ReviewIssue[]; suggestions: ReviewIssue[]; untraced_claims: string[]; score: number; passed?: boolean }
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
  /** Flow 3: hire another agent for a task (A2A + escrow). Absent = no hiring configured. */
  hire?: (task: string) => Promise<{ text: string; paymentId: string; amount: string; payTo: string }>;
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

/**
 * Last resort after the review rounds: delete every slide line that contains a quoted blocking item or untraced
 * claim. Returns null if any quote can't be found (then the job stops rather than ship something unchecked).
 */
export function redact(md: string, quotes: string[]): { markdown: string; removed: string[] } | null {
  const norm = (t: string) => t.toLowerCase().replace(/[*_`"“”'’]/g, "").replace(/\s+/g, " ").trim();
  const lines = md.split("\n");
  const removed: string[] = [];
  for (const q of quotes) {
    const nq = norm(q);
    if (nq.length < 8) return null;
    const i = lines.findIndex((l) => !l.startsWith("#") && !l.startsWith("---") && norm(l).includes(nq.slice(0, 80)));
    if (i < 0) return null;
    removed.push(lines[i]!);
    lines.splice(i, 1);
  }
  return { markdown: lines.join("\n"), removed };
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

  async factcheck(c) {
    // Hiring is a bonus, never a blocker: any failure leaves a note and the deck continues (docs/swarm.md).
    if (!c.hire) return { skipped: "no hiring configured" };
    const { dossier } = c.done.research as { dossier: Dossier };
    const { strategy } = c.done.council as { strategy: Strategy };
    const used = new Set(strategy.slides.flatMap((s) => s.evidence ?? []));
    const claims = dossier.findings.filter((f) => used.has(f.id)).map((f) => ({ id: f.id, claim: f.claim, source: f.source_url ?? f.source_title }));
    if (claims.length === 0) return { skipped: "no cited claims to check" };
    try {
      const r = await c.hire(`Fact-check these pitch-deck claims and return your JSON verdicts:\n${JSON.stringify(claims, null, 1)}`);
      return { hired: { payTo: r.payTo, amount: r.amount, paymentId: r.paymentId }, result: r.text };
    } catch (e) {
      c.log?.(`factcheck: hire failed, continuing without (${(e as Error).message})`);
      return { skipped: (e as Error).message.slice(0, 300) };
    }
  },

  async write(c) {
    const brief = c.done.brief as Brief;
    const { dossier } = c.done.research as { dossier: Dossier };
    const { strategy } = c.done.council as { strategy: Strategy };
    const fc = c.done.factcheck as { result?: string } | undefined;
    const factcheck = fc?.result ? [block("findings", { independent_fact_check: fc.result }), "Drop or reword claims the fact-check marks unsupported; prefer its safer_wording for weak ones."] : [];
    const md = cleanDeck(await c.ask<string>("copywriter", [block("brief", brief), block("dossier", dossier), block("draft", strategy), ...factcheck].join("\n\n")));
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
    const ROUNDS = 3; // first review + up to two edits
    for (let round = 0; round < ROUNDS; round++) {
      const problems = checkDeck(md, dossier);
      const review = await c.ask<Review>("reviewer", [block("brief", brief), block("dossier", dossier), block("draft", md)].join("\n\n"));
      // Only hard rules block: deterministic checks, untraced claims, blocking issues. Style never blocks.
      const blocking = review.blocking ?? [];
      const untraced = review.untraced_claims ?? [];
      const passed = problems.length === 0 && untraced.length === 0 && blocking.length === 0;
      rounds.push({ review: { ...review, passed }, problems });
      if (passed) return { markdown: md, passed: true, rounds };
      if (round === ROUNDS - 1) break;
      // One rework: the copywriter gets the issues and rewrites (the cover image line is kept).
      const cover = md.match(/!\[bg right:40%\]\([^)]+\)\n\n/)?.[0] ?? "";
      const fix = { must_fix: blocking, untraced_claims: untraced, checks: problems, nice_to_have: (review.suggestions ?? []).slice(0, 3) };
      // Edit the existing draft rather than starting over, so fixed slides don't regress.
      let next = cleanDeck(await c.ask<string>("copywriter", [block("brief", brief), block("dossier", dossier), block("draft", md), block("findings", fix), "Edit the deck in <draft>. For every item in must_fix, untraced_claims and checks: apply the fix literally — if in doubt, delete that sentence or prefix it with \"Assumption:\". Apply nice_to_have only if easy. Keep everything else unchanged and return the whole corrected deck."].join("\n\n")));
      // Exactly one cover, on the title slide, whatever the edit did with it.
      next = next.replace(/!\[bg right:40%\]\([^)]+\)\n\n?/g, "");
      if (cover) next = next.replace(/(^---\n[\s\S]*?\n---\n\s*\n?)(#)/, `$1${cover}$2`);
      md = next;
    }
    // Deterministic last step: remove exactly the quoted lines, re-run the hard checks, ship only if clean.
    const last = rounds.at(-1)!;
    const quotes = [...(last.review.blocking ?? []).map((b) => b.quote ?? ""), ...(last.review.untraced_claims ?? [])].filter(Boolean);
    const r = last.problems.length === 0 && quotes.length > 0 ? redact(md, quotes) : null;
    if (r && checkDeck(r.markdown, dossier).length === 0) {
      c.log?.(`review: removed ${r.removed.length} unsupported line(s) after ${ROUNDS} rounds`);
      return { markdown: r.markdown, passed: true, rounds, redacted: r.removed };
    }
    throw new JobStop(`deck failed review after ${ROUNDS} rounds: ${JSON.stringify(rounds.at(-1))}`.slice(0, 1000), "failed_review");
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
