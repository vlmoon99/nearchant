import { describe, expect, it } from "vitest";
import { waitWhileFenced } from "../src/fence.js";

const answers = (...a: (string | Error)[]) => {
  let i = 0;
  return (async () => { const x = a[Math.min(i++, a.length - 1)]!; if (x instanceof Error) throw x; return new Response(x); }) as unknown as typeof fetch;
};

describe("standby fence", () => {
  it("starts at once without a fence URL, or when the standby is standing by or unreachable", async () => {
    await waitWhileFenced(undefined);
    let slept = 0;
    await waitWhileFenced("http://mac/role", { fetchFn: answers("standby"), sleep: async () => { slept++; } });
    await waitWhileFenced("http://mac/role", { fetchFn: answers(new Error("timeout")), sleep: async () => { slept++; } });
    expect(slept).toBe(0);
  });
  it("waits while the standby is primary, then starts when it is not", async () => {
    let slept = 0; const logs: string[] = [];
    await waitWhileFenced("http://mac/role", { fetchFn: answers("primary\n", "primary", "standby"), sleep: async () => { slept++; }, log: (m) => logs.push(m) });
    expect(slept).toBe(2);
    expect(logs).toHaveLength(1);
  });
});
