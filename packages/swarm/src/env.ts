import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

export interface Role {
  name: string;
  /** Shared rules + the role prompt. */
  system: string;
  seat: "main" | "second" | "smart";
  output: "json" | "markdown";
  temperature: number;
  max_tokens: number;
  /** Per-call timeout in seconds (optional). */
  timeout_s?: number;
  /** false: answer without thinking first (short structured outputs); true: think first even where the endpoint
   *  turns thinking off by default (providers extra_body). Unset: the endpoint's default. */
  reasoning?: boolean;
}

export interface AgentEnv {
  name: string;
  version: string;
  seats: { main: { model?: string }; second: { model?: string }; smart: { model?: string } };
  roles: Record<string, Role>;
  research: { scouts: { focus: string; ask: string }[] };
  dir: string;
}

/** Loads an Agent Environment folder (architecture.md §11): agentenv.yaml, roles/*.yaml, prompts/*.md. */
export function loadAgentEnv(dir: string): AgentEnv {
  const m = parse(readFileSync(join(dir, "agentenv.yaml"), "utf8"));
  if (m.spec !== "nearchant.com/spec/agentenv/v1") throw new Error(`${dir}: unsupported spec ${m.spec}`);
  const rules = readFileSync(join(dir, "prompts/_rules.md"), "utf8").trim();
  const roles: Record<string, Role> = {};
  for (const name of m.roles as string[]) {
    const r = parse(readFileSync(join(dir, "roles", `${name}.yaml`), "utf8"));
    if (!["main", "second", "smart"].includes(r.seat)) throw new Error(`role ${name}: bad seat ${r.seat}`);
    roles[name] = {
      name,
      system: `${readFileSync(join(dir, r.prompt), "utf8").trim()}\n\n${rules}`,
      seat: r.seat,
      output: r.output,
      temperature: Number(r.temperature ?? 0.4),
      max_tokens: Number(r.max_tokens ?? 2000),
      ...(r.timeout_s ? { timeout_s: Number(r.timeout_s) } : {}),
      ...(typeof r.reasoning === "boolean" ? { reasoning: r.reasoning } : {}),
    };
  }
  return { name: m.name, version: m.version, seats: { main: m.seats?.main ?? {}, second: m.seats?.second ?? {}, smart: m.seats?.smart ?? {} }, roles, research: m.research, dir };
}
