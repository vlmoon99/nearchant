import { describe, expect, it } from "vitest";
import { MailError, normEmail, readEmailToken, resendMailer, signEmailToken } from "../src/email.js";

const key = Buffer.alloc(32, 7);
const mail = { to: "owner@example.com", subject: "Hi", text: "Hello", idempotencyKey: "k1" };

describe("email", () => {
  it("sends once with the idempotency key, retries 5xx/network errors, gives up on 4xx", async () => {
    const calls: RequestInit[] = [];
    const seq = [new Error("socket hang up"), new Response("busy", { status: 503 }), new Response("{}", { status: 200 })];
    const send = resendMailer({ apiKey: "re_x", from: "Nearchant <hello@nearchant.com>", apiUrl: "https://api/emails", sleep: async () => {},
      fetchFn: (async (_u: string, init: RequestInit) => { calls.push(init); const x = seq.shift()!; if (x instanceof Error) throw x; return x; }) as unknown as typeof fetch });
    await send(mail);
    expect(calls).toHaveLength(3);
    expect((calls[0]!.headers as Record<string, string>)["idempotency-key"]).toBe("k1");
    expect(JSON.parse(String(calls[0]!.body))).toMatchObject({ from: "Nearchant <hello@nearchant.com>", to: ["owner@example.com"], subject: "Hi" });
    let n = 0;
    const bad = resendMailer({ apiKey: "re_x", from: "x@y.z", apiUrl: "https://api/emails", sleep: async () => {}, fetchFn: (async () => { n++; return new Response("invalid to", { status: 422 }); }) as unknown as typeof fetch });
    await expect(bad(mail)).rejects.toBeInstanceOf(MailError);
    expect(n).toBe(1);
    const down = resendMailer({ apiKey: "re_x", from: "x@y.z", apiUrl: "https://api/emails", sleep: async () => {}, fetchFn: (async () => { throw new Error("timeout"); }) as unknown as typeof fetch });
    await expect(down(mail)).rejects.toThrow(/o…@example.com failed: timeout/);
  });

  it("signs link tokens that expire and can't be forged", () => {
    const t = signEmailToken(key, { k: "signin", h: "nova", e: "a@b.co", exp: Date.now() + 60_000 });
    expect(readEmailToken(key, t)).toMatchObject({ k: "signin", h: "nova", e: "a@b.co" });
    expect(readEmailToken(key, t, Date.now() + 120_000)).toBeNull();
    expect(readEmailToken(Buffer.alloc(32, 8), t)).toBeNull();
    const [body, mac] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString()), h: "other" })).toString("base64url");
    expect(readEmailToken(key, `${forged}.${mac}`)).toBeNull();
  });

  it("accepts only plain email addresses", () => {
    expect(normEmail("  Owner@Example.COM ")).toBe("owner@example.com");
    for (const bad of ["no-at", "a@b", "a b@c.com", "<a@b.com>", "a@b.com, c@d.com"]) expect(normEmail(bad)).toBeNull();
  });
});
