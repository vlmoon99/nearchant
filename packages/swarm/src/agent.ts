import type { ResultEnvelope } from "@nearchant/contracts";
import type { CapabilityRequest } from "@nearchant/providers";
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
export function makeAsker(env: AgentEnv, router: ModelRouter, track: (e: ResultEnvelope, role: string) => Promise<void>): Asker {
  return async function ask<T>(roleName: string, user: string): Promise<T> {
    const role: Role | undefined = env.roles[roleName];
    if (!role) throw new Error(`unknown role ${roleName}`);
    const model = env.seats[role.seat]?.model;
    const messages: { role: string; content: string }[] = [
      { role: "system", content: role.system },
      { role: "user", content: user },
    ];
    let maxTokens = role.max_tokens;
    for (let attempt = 0; attempt < 2; attempt++) {
      const e = await router.call({
        capability: "chat",
        dataClass: "private",
        ...(model ? { model } : {}),
        input: { messages, temperature: role.temperature, max_tokens: maxTokens },
      });
      await track(e, roleName);
      const text = contentOf(e);
      // Reasoning models can spend the whole budget thinking: retry the same request with more room.
      if ((e.output as { finish_reason?: string }).finish_reason === "length" && attempt === 0) {
        maxTokens = Math.min(maxTokens * 2, 16_000);
        continue;
      }
      if (role.output === "markdown") return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim() as T;
      try {
        return extractJson(text) as T;
      } catch (err) {
        messages.push({ role: "assistant", content: text.slice(0, 4000) }, { role: "user", content: `That was not valid JSON (${(err as Error).message}). Reply with only the JSON object.` });
      }
    }
    throw new Error(`${roleName}: no valid JSON after a retry`);
  };
}
