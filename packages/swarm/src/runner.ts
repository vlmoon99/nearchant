import type { ResultEnvelope } from "@nearchant/contracts";
import { makeAsker, type ModelRouter } from "./agent.js";
import type { AgentEnv } from "./env.js";
import { JobStop, PIPELINE, STEPS, nextStep, type Step, type StepContext } from "./steps.js";

export interface ArtifactStore {
  get<T>(orderId: string, step: string): Promise<T | null>;
  put(orderId: string, step: string, data: unknown): Promise<boolean>;
  all(orderId: string): Promise<Record<string, unknown>>;
}

export interface JobDeps {
  env: AgentEnv;
  router: ModelRouter;
  artifacts: ArtifactStore;
  /** Persist an envelope right away (honest metering, even when the step later fails). */
  record: (orderId: string, step: Step, role: string, e: ResultEnvelope) => Promise<void>;
  media: StepContext["media"];
  render: StepContext["render"];
  deliver: StepContext["deliver"];
  search?: StepContext["search"];
  hire?: StepContext["hire"];
  log?: (msg: string) => void;
}

export type StepOutcome = { status: "done"; next: Step | null } | { status: "stopped"; kind: JobStop["kind"]; reason: string };

/** Runs one step of an order's job. Idempotent: a step whose artifact exists only reports the next step. */
export async function runStep(d: JobDeps, orderId: string, brief: string, step: Step): Promise<StepOutcome> {
  if (await d.artifacts.get(orderId, step)) return { status: "done", next: nextStep(step) };
  const done = (await d.artifacts.all(orderId)) as StepContext["done"];
  const attestations: string[] = [];
  const track = async (e: ResultEnvelope, role: string) => {
    if (e.attestation) attestations.push(e.attestation.reportHash);
    await d.record(orderId, step, role, e);
  };
  const ctx: StepContext = {
    orderId, brief, env: d.env, router: d.router, done,
    ask: makeAsker(d.env, d.router, track, (role, model, why) => d.log?.(`${orderId} ${step}: ${role} fell back from ${model} to the main seat (${why.slice(0, 120)})`)), track,
    media: d.media, render: d.render, deliver: d.deliver, search: d.search, hire: d.hire, log: d.log,
    attestationRef: async () => {
      if (attestations.length) return attestations.at(-1)!;
      const prev = Object.values(done).map((a) => (a as { attestation?: string })?.attestation).filter(Boolean) as string[];
      return prev.at(-1) ?? null;
    },
  };
  try {
    const out = (await STEPS[step](ctx)) as Record<string, unknown>;
    const withAttest = attestations.length ? { ...out, attestation: attestations.at(-1) } : out;
    await d.artifacts.put(orderId, step, withAttest);
    d.log?.(`${orderId} ${step} done`);
    return { status: "done", next: nextStep(step) };
  } catch (e) {
    if (e instanceof JobStop) {
      await d.artifacts.put(orderId, `stopped`, { step, kind: e.kind, reason: e.reason, detail: ctx.stopDetail ?? null });
      return { status: "stopped", kind: e.kind, reason: e.reason };
    }
    throw e;
  }
}

/** Runs the whole pipeline in-process (tests, CLI demo). The worker runs one step per queued job instead. */
export async function runPipeline(d: JobDeps, orderId: string, brief: string): Promise<StepOutcome> {
  let step: Step | null = PIPELINE[0];
  let last: StepOutcome = { status: "done", next: step };
  while (step) {
    last = await runStep(d, orderId, brief, step);
    if (last.status !== "done") return last;
    step = last.next;
  }
  return last;
}
