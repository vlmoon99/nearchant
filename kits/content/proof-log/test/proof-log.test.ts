import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProofLog, ProofLogError, fingerprint, matches, parseEntry, partsHash, rpcView, sha256, type Entry, type NewEntry, type Signer, type View } from "../src/index.js";

const LOG = "proofs.test.near";

/** An in-memory stand-in for the proof-log contract. */
function fakeLog() {
  const entries: Entry[] = [];
  const calls: { signer: string; methodName: string; args: Record<string, unknown>; deposit: bigint }[] = [];
  const view: View = async (contractId, method, args) => {
    expect(contractId).toBe(LOG);
    const page = (list: Entry[]) => list.slice(Number(args.from_index ?? 0), Number(args.from_index ?? 0) + Number(args.limit ?? 100));
    if (method === "get") return entries.find((e) => e.id === args.id) ?? null;
    if (method === "find_by_hash") return page(entries.filter((e) => e.content_hash === args.content_hash));
    if (method === "list_by_author") return page(entries.filter((e) => e.author_id === args.author_id));
    if (method === "count_by_author") return String(entries.filter((e) => e.author_id === args.author_id).length);
    if (method === "is_passed") {
      const e = entries.find((x) => x.id === args.proof_id);
      return !!e && e.passed !== false && e.subject === args.subject && e.author_id === args.author_id;
    }
    throw new Error(`unexpected view ${method}`);
  };
  const write = (accountId: string, entry: NewEntry) => {
    const e: Entry = { ...entry, id: String(entries.length + 1), author_id: accountId, created_at: "1700000000000000000", block_height: "10" };
    entries.push(e);
    return e.id;
  };
  const signer = (accountId: string, behave?: (args: Record<string, unknown>) => unknown): Signer => ({
    accountId,
    call: async (p) => {
      calls.push({ signer: accountId, methodName: p.methodName, args: p.args, deposit: p.deposit });
      if (behave) return behave(p.args);
      return write(accountId, p.args.entry as NewEntry);
    },
  });
  return { entries, calls, view, signer, write };
}

describe("fingerprint", () => {
  it("hashes one value with sha256", () => {
    const e = fingerprint("hello", { producer: "model:test", subject: "post:1", madeAt: new Date("2026-11-08T10:00:00Z") });
    expect(e.content_hash).toBe(createHash("sha256").update("hello").digest("hex"));
    expect(e).toMatchObject({ producer: "model:test", subject: "post:1", passed: null });
    expect(JSON.parse(e.metadata!)).toEqual({ made_at: "2026-11-08T10:00:00.000Z" });
    expect(fingerprint(Buffer.from("hello")).content_hash).toBe(e.content_hash);
    expect(fingerprint("hello").metadata).toBeNull();
  });

  it("hashes named parts (caption + image), keeping each part's hash so one can be proven alone", () => {
    const image = Buffer.from([1, 2, 3, 4]);
    const e = fingerprint({ caption: "Fresh bread today", image }, { producer: "model:qwen3 + image-edit", metadata: { model: "qwen3" } });
    const md = JSON.parse(e.metadata!) as { parts: Record<string, string>; model: string };
    expect(md.parts).toEqual({ caption: sha256("Fresh bread today"), image: sha256(image) });
    expect(md.model).toBe("qwen3");
    expect(e.content_hash).toBe(partsHash(md.parts));
    // Order of keys doesn't matter; any change does.
    expect(fingerprint({ image, caption: "Fresh bread today" }).content_hash).toBe(e.content_hash);
    expect(fingerprint({ caption: "Fresh bread today!", image }).content_hash).not.toBe(e.content_hash);
    expect(matches({ caption: "Fresh bread today", image }, e)).toBe(true);
    expect(matches("Fresh bread today", e)).toBe(false);
  });

  it("refuses what the contract would refuse", () => {
    expect(() => fingerprint({})).toThrow(/no parts/);
    expect(() => fingerprint("x", { metadata: { big: "x".repeat(3000) } })).toThrow(/2048/);
    expect(() => fingerprint("x", { subject: "s".repeat(129) })).toThrow(/subject/);
  });
});

describe("ProofLog", () => {
  it("prove → get → check → list by author", async () => {
    const f = fakeLog();
    const log = new ProofLog({ contractId: LOG, view: f.view, signer: f.signer("alice.near") });
    const r = await log.prove({ caption: "hi", image: "img" }, { subject: "post:1", producer: "model:x" });
    expect(r).toEqual({ id: "1", existing: false });
    expect(f.calls[0]!.methodName).toBe("record");
    expect(f.calls[0]!.deposit > 0n).toBe(true);
    expect((await log.get("1"))?.subject).toBe("post:1");
    expect(await log.get("9")).toBeNull();
    expect((await log.check({ caption: "hi", image: "img" }))?.id).toBe("1");
    expect(await log.check({ caption: "hi", image: "img" }, { authorId: "mallory.near" })).toBeNull();
    expect(await log.check({ caption: "edited", image: "img" })).toBeNull();
    await log.prove("second");
    expect((await log.listByAuthor("alice.near")).map((e) => e.id)).toEqual(["1", "2"]);
    expect((await log.listByAuthor("alice.near", { fromIndex: 1, limit: 1 })).map((e) => e.id)).toEqual(["2"]);
    expect(await log.countByAuthor("alice.near")).toBe(2);
    expect(await log.isPassed("1", "post:1", "alice.near")).toBe(true);
    expect(await log.isPassed("1", "post:1", "mallory.near")).toBe(false);
  });

  it("is idempotent: the same author + content + subject is not written twice", async () => {
    const f = fakeLog();
    const log = new ProofLog({ contractId: LOG, view: f.view, signer: f.signer("alice.near") });
    await log.prove("same", { subject: "post:1" });
    expect(await log.prove("same", { subject: "post:1" })).toEqual({ id: "1", existing: true });
    expect(f.calls).toHaveLength(1);
    // Someone else proving the same content gets their own entry; so does a new subject, or dedupe: false.
    await log.as(f.signer("bob.near")).prove("same", { subject: "post:1" });
    await log.prove("same", { subject: "post:2" });
    await log.prove("same", { subject: "post:1" }, { dedupe: false });
    expect(f.entries).toHaveLength(4);
  });

  it("after a write timeout, finds the entry on chain instead of failing", async () => {
    const f = fakeLog();
    const signer = f.signer("alice.near", (args) => { f.write("alice.near", args.entry as NewEntry); return new Promise(() => {}); });
    const log = new ProofLog({ contractId: LOG, view: f.view, signer, txTimeoutMs: 20 });
    expect(await log.prove("late")).toEqual({ id: "1", existing: false });
  });

  it("a failed write surfaces the contract's panic message", async () => {
    const f = fakeLog();
    const signer = f.signer("alice.near", () => { throw new Error("Smart contract panicked: attach at least 6500000000000000000000 yoctoNEAR for storage"); });
    const log = new ProofLog({ contractId: LOG, view: f.view, signer, retries: 0 });
    const err = await log.prove("x").catch((e) => e);
    expect(err).toBeInstanceOf(ProofLogError);
    expect(err.message).toMatch(/^record failed: attach at least/);
    expect(f.calls).toHaveLength(1);
  });

  it("needs a signer to write, and a sane hash", async () => {
    const f = fakeLog();
    await expect(new ProofLog({ contractId: LOG, view: f.view }).prove("x")).rejects.toThrow(/no signer/);
    const log = new ProofLog({ contractId: LOG, view: f.view, signer: f.signer("a.near") });
    await expect(log.record({ content_hash: "", producer: null, subject: null, passed: null, metadata: null })).rejects.toThrow(/content_hash/);
  });

  it("reads retry with backoff, time out, and validate the chain's answer", async () => {
    let n = 0;
    const flaky: View = async () => { if (++n < 3) throw new Error("503"); return []; };
    expect(await new ProofLog({ contractId: LOG, view: flaky, retryDelayMs: 1 }).findByHash("h")).toEqual([]);
    expect(n).toBe(3);
    const hang: View = () => new Promise(() => {});
    await expect(new ProofLog({ contractId: LOG, view: hang, timeoutMs: 10, retries: 0 }).get("1")).rejects.toThrow(/timed out/);
    const junk: View = async () => [{ id: 1 }];
    await expect(new ProofLog({ contractId: LOG, view: junk, retries: 0 }).findByHash("h")).rejects.toThrow(ProofLogError);
    expect(() => parseEntry({ id: "1", author_id: "a", content_hash: "h", created_at: "1", block_height: "1", passed: "yes" })).toThrow(/passed/);
  });
});

describe("rpcView (near-api-js over a fake JSON-RPC)", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("decodes a call_function result", async () => {
    const entry = { id: "1", author_id: "alice.near", content_hash: "h", producer: null, subject: null, passed: null, metadata: null, created_at: "1", block_height: "2" };
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      const req = JSON.parse(init.body) as { id: unknown; params: Record<string, string> };
      expect(req.params).toMatchObject({ request_type: "call_function", account_id: LOG, method_name: "get" });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { result: [...Buffer.from(JSON.stringify(entry))], logs: [], block_height: 1, block_hash: "x" } }));
    }));
    const log = new ProofLog({ contractId: LOG, view: rpcView({ rpcUrls: ["http://rpc.invalid"], retries: 0 }) });
    expect((await log.get("1"))?.author_id).toBe("alice.near");
  });
});
