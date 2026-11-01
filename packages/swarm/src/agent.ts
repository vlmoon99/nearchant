import type { ResultEnvelope } from "@nearchant/contracts";
import { NoEndpointError, type CapabilityRequest } from "@nearchant/providers";
import type { AgentEnv, Role } from "./env.js";

export interface ModelRouter {
  call(req: CapabilityRequest): Promise<ResultEnvelope>;
}

/** Wraps data in a tagged block so prompts can tell instructions from data (prompts/_rules.md). */
export function block(tag: string, value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 1);
  // A closing tag inside the data can't end the block early.
  return `<${tag}>\n${text.replaceAll(`</${tag}>`, `<\\/${tag}>`)}\n</${tag}>`;
}

/** Pulls the first JSON object out of a model answer (tolerates ``` fences, <think> blocks, chatter). */
export function extractJson(text: string): unknown {
  const t = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1]! : t;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in answer");
  return JSON.parse(body.slice(start, end + 1));
}

export function contentOf(env: ResultEnvelope): string {
  const msg = (env.output as { message?: { content?: unknown } })?.message;
  const c = msg?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === "string" ? p : (p as { text?: string }).text ?? "")).join("");
  return "";
}

export interface Asker {
  /** Calls a role; JSON roles return parsed JSON (one repair retry), markdown roles return text. */
  <T = unknown>(roleName: string, user: string): Promise<T>;
}

/** Builds the role caller for one job. `track` receives every envelope (metering, proof). */
export function makeAsker(env: AgentEnv, router: ModelRouter, track: (e: ResultEnvelope, role: string) => Promise<void>, onDegrade?: (role: string, model: string, reason: string) => void): Asker {
  // Once a seat model failed in this step, later calls skip it (no repeated multi-minute timeouts).
  const degraded = new Set<string>();
  const degrade = (role: string, model: string, why: string) => { degraded.add(model); onDegrade?.(role, model, why); };
  return async function ask<T>(roleName: string, user: string): Promise<T> {
    const role: Role | undefined = env.roles[roleName];
    if (!role) throw new Error(`unknown role ${roleName}`);
    const seat = env.seats[role.seat]?.model;
    const model = seat && !degraded.has(seat) ? seat : undefined;
    const messages: { role: string; content: string }[] = [
      { role: "system", content: role.system },
      { role: "user", content: user },
    ];
    let maxTokens = role.max_tokens;
    let seatModel = model;
    let lengthRetried = false;
    let parseFailures = 0;
    for (let calls = 0; calls < 5; calls++) {
      const req = { capability: "chat" as const, dataClass: "private" as const, input: { messages, temperature: role.temperature, max_tokens: maxTokens }, ...(role.timeout_s && seatModel ? { timeoutMs: role.timeout_s * 1000 } : {}) };
      let e: ResultEnvelope;
      try {
        e = await router.call(seatModel ? { ...req, model: seatModel } : req);
      } catch (err) {
        // The second seat is a preference: if its model is unreachable, degrade to the main route (architecture §3.10).
        if (!(err instanceof NoEndpointError) || !seatModel) throw err;
        degrade(roleName, seatModel, (err as Error).message);
        seatModel = undefined;
        const { timeoutMs: _, ...mainReq } = req as typeof req & { timeoutMs?: number };
        e = await router.call(mainReq);
      }
      await track(e, roleName);
      const text = contentOf(e);
      // Reasoning models can spend the whole budget thinking: retry once with more room (not a parse failure).
      if ((e.output as { finish_reason?: string }).finish_reason === "length" && !lengthRetried) {
        lengthRetried = true;
        maxTokens = Math.min(maxTokens * 2, 16_000);
        continue;
      }
      if (role.output === "markdown") return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim() as T;
      try {
        return extractJson(text) as T;
      } catch (err) {
        parseFailures++;
        if (parseFailures === 1) {
          messages.push({ role: "assistant", content: text.slice(0, 4000) }, { role: "user", content: `That was not valid JSON (${(err as Error).message}). Reply with only the JSON object.` });
        } else if (seatModel) {
          // The second-seat model can't produce the format: let the main seat answer the original request.
          degrade(roleName, seatModel, "no valid JSON from the second seat");
          seatModel = undefined;
          messages.splice(2);
          lengthRetried = false;
          maxTokens = role.max_tokens;
        } else {
          break;
        }
      }
    }
    throw new Error(`${roleName}: no valid JSON after a retry`);
  };
}
