import { fingerprint, type Content, type FingerprintMeta, type NewEntry } from "./fingerprint.js";
import { rpcView, type Network, type Signer, type View } from "./near.js";
import { retry, withTimeout } from "./retry.js";

/** An entry as the contract returns it. Ids, times and heights are decimal strings (U64); `created_at` is in ns. */
export interface Entry extends NewEntry {
  id: string;
  author_id: string;
  created_at: string;
  block_height: string;
}

export interface ProofLogOptions {
  /** The proof-log contract account, e.g. `proofs.yourname.testnet`. */
  contractId: string;
  network?: Network;
  rpcUrls?: string[];
  /** Read calls. Default: JSON-RPC via near-api-js. Pass your own (or a fake in tests). */
  view?: View;
  /** Who writes entries (the entry's author is always this account). Switch with `.as(otherSigner)`. */
  signer?: Signer;
  /** Per request (default 15 s for reads, 60 s for transactions). */
  timeoutMs?: number;
  txTimeoutMs?: number;
  /** Retries for reads (default 3) and the first backoff delay (default 300 ms). Writes are never blindly retried. */
  retries?: number;
  retryDelayMs?: number;
}

export interface RecordOptions {
  /**
   * Skip the write when this author already logged the same `content_hash` + `subject` (default true). This is the
   * idempotency key: retrying `record` after a timeout never writes a second entry.
   */
  dedupe?: boolean;
  /** NEAR (in yocto) attached for storage; the contract refunds what it doesn't use. Default: estimated, ×2. */
  depositYocto?: bigint;
}

export interface RecordResult {
  id: string;
  /** True when an identical entry by this author already existed, so nothing was written. */
  existing: boolean;
}

const TGAS = 10n ** 12n;
const BYTE_COST = 10n ** 19n; // yoctoNEAR per byte of storage on NEAR

export class ProofLogError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "ProofLogError";
  }
}

/** Client for the proof-log contract: write fingerprints, read them back, check content against them. */
export class ProofLog {
  readonly contractId: string;
  private readonly view: View;

  constructor(private readonly opts: ProofLogOptions) {
    if (!opts.contractId) throw new ProofLogError("contractId is required");
    this.contractId = opts.contractId;
    this.view = opts.view ?? rpcView({ network: opts.network, rpcUrls: opts.rpcUrls, timeoutMs: opts.timeoutMs, retries: 0 });
  }

  as(signer: Signer): ProofLog {
    return new ProofLog({ ...this.opts, view: this.view, signer });
  }

  /** Fingerprints `content` and records it in one step. */
  prove(content: Content | Record<string, Content>, meta: FingerprintMeta = {}, o: RecordOptions = {}): Promise<RecordResult> {
    return this.record(fingerprint(content, meta), o);
  }

  /** Writes an entry (see `fingerprint`). Returns its id. */
  async record(entry: NewEntry, o: RecordOptions = {}): Promise<RecordResult> {
    const signer = this.opts.signer;
    if (!signer) throw new ProofLogError("no signer: pass `signer` or use `.as(signer)`");
    if (!entry.content_hash || entry.content_hash.length > 128) throw new ProofLogError("content_hash must be 1..128 chars");
    const dedupe = o.dedupe ?? true;
    const same = async () => (await this.findByHash(entry.content_hash)).find((e) => e.author_id === signer.accountId && e.subject === entry.subject);
    if (dedupe) {
      const prior = await same();
      if (prior) return { id: prior.id, existing: true };
    }
    const deposit = o.depositYocto ?? estimateDeposit(entry, signer.accountId);
    let id: unknown;
    try {
      id = await withTimeout(
        signer.call({ contractId: this.contractId, methodName: "record", args: { entry }, gas: 30n * TGAS, deposit }),
        this.opts.txTimeoutMs ?? 60_000, "record");
    } catch (e) {
      // The write may have landed even if we didn't hear back: look before failing (only when deduping).
      if (dedupe) {
        const landed = await same().catch(() => undefined);
        if (landed) return { id: landed.id, existing: false };
      }
      throw new ProofLogError(`record failed: ${panicText(e)}`, e);
    }
    if (typeof id !== "string" || !/^\d+$/.test(id)) throw new ProofLogError(`record returned an unexpected value: ${String(id)}`);
    return { id, existing: false };
  }

  async get(id: string): Promise<Entry | null> {
    const v = await this.read("get", { id });
    return v == null ? null : parseEntry(v);
  }

  /** An author's entries, oldest first (pages of up to 100). */
  async listByAuthor(authorId: string, o: { fromIndex?: number; limit?: number } = {}): Promise<Entry[]> {
    return parseList(await this.read("list_by_author", { author_id: authorId, from_index: o.fromIndex != null ? String(o.fromIndex) : null, limit: o.limit ?? null }));
  }

  async countByAuthor(authorId: string): Promise<number> {
    return Number(await this.read("count_by_author", { author_id: authorId }));
  }

  /** Every entry with this fingerprint, oldest first: the first one is the earliest proof it existed. */
  async findByHash(contentHash: string, o: { fromIndex?: number; limit?: number } = {}): Promise<Entry[]> {
    return parseList(await this.read("find_by_hash", { content_hash: contentHash, from_index: o.fromIndex != null ? String(o.fromIndex) : null, limit: o.limit ?? null }));
  }

  /**
   * Was this exact content logged? Returns the earliest entry (optionally only by `authorId`), or null. Pass the same
   * shape you proved: one value, or the same named parts.
   */
  async check(content: Content | Record<string, Content>, o: { authorId?: string } = {}): Promise<Entry | null> {
    const found = await this.findByHash(fingerprint(content).content_hash);
    return found.find((e) => !o.authorId || e.author_id === o.authorId) ?? null;
  }

  /** The contract's own check: entry exists, is about `subject`, was written by `authorId`, didn't fail review. */
  async isPassed(proofId: string, subject: string, authorId: string): Promise<boolean> {
    return (await this.read("is_passed", { proof_id: proofId, subject, author_id: authorId })) === true;
  }

  private read(method: string, args: Record<string, unknown>): Promise<unknown> {
    return retry(() => withTimeout(this.view(this.contractId, method, args), this.opts.timeoutMs ?? 15_000, `view ${method}`), {
      retries: this.opts.retries, retryDelayMs: this.opts.retryDelayMs,
    });
  }
}

/** Storage the entry and its two indexes will use, doubled for safety (the contract refunds the rest). */
export function estimateDeposit(entry: NewEntry, authorId: string): bigint {
  const bytes = 300 + JSON.stringify(entry).length + 3 * authorId.length + 3 * entry.content_hash.length;
  return BigInt(bytes) * BYTE_COST * 2n;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Checks the shape the chain returned instead of casting it. */
export function parseEntry(v: unknown): Entry {
  if (!isObj(v)) throw new ProofLogError("bad contract data: entry is not an object");
  const s = (k: string) => { if (typeof v[k] !== "string") throw new ProofLogError(`bad contract data: ${k}`); return v[k] as string; };
  const os = (k: string) => (v[k] == null ? null : s(k));
  const passed = v.passed == null ? null : v.passed;
  if (passed !== null && typeof passed !== "boolean") throw new ProofLogError("bad contract data: passed");
  return {
    id: s("id"), author_id: s("author_id"), content_hash: s("content_hash"), producer: os("producer"), subject: os("subject"),
    passed, metadata: os("metadata"), created_at: s("created_at"), block_height: s("block_height"),
  };
}

function parseList(v: unknown): Entry[] {
  if (!Array.isArray(v)) throw new ProofLogError("bad contract data: expected a list");
  return v.map(parseEntry);
}

function panicText(e: unknown): string {
  const msg = String((e as Error)?.message ?? e);
  const m = msg.match(/Smart contract panicked: ([^"\n]+)/);
  return m ? m[1]!.trim() : msg;
}
