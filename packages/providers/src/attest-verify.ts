import { createHash, createPublicKey, createVerify } from "node:crypto";
// Checks a NEAR AI attestation report (GET /v1/attestation/report?model=&nonce=) as far as we can without trusting
// NEAR AI, following docs.near.ai/cloud/verification: freshness (our nonce comes back), binding (the TDX quote's
// REPORTDATA = NEAR AI's signing key ‖ our nonce; the model's quote = its signing address ‖ our nonce), measurements
// (MRCONFIGID = 01 ‖ sha256(app_compose) ‖ zeros; the event log replays to RTMR3; no debug TD), the
// Intel TDX quote itself (Phala's public DCAP verifier), that the NVIDIA GPU evidence is for our nonce, and — with an
// NVIDIA API key — NVIDIA's own verdict on that evidence (NRAS: POST /v4 (or /v3)/attest/gpu, the same request as NVIDIA's
// nv_attestation_sdk; the answer is ES384 JWTs checked here against NRAS's JWKS, overall result + our nonce).
// NRAS refuses some networks (HTML 403 at its load balancer): `nvidia.baseUrl` can point at a relay (our own Worker,
// deploy/nras-relay). NVIDIA's signed overall token is published in the check, so anyone can verify it against NRAS's
// JWKS themselves.
export interface ReportCheck {
  nonce_ok: boolean; gateway_bound: boolean;
  /** MRCONFIGID = 0x01 ‖ sha256(app_compose) ‖ 15 zero bytes (the configuration the TEE was booted with). */
  compose_bound: boolean;
  /** The event log (imr 3) replays to the quote's RTMR3; the TD is not in debug mode. */
  gateway_rtmr3_ok?: boolean; gateway_debug?: boolean;
  models: { model: string; bound: boolean; gpu_nonce_ok: boolean; tdx_verified: boolean | null;
    /** NEAR AI's own models only (third-party layouts carry no app_compose / event log): null = not applicable. */
    compose_bound?: boolean | null; rtmr3_ok?: boolean | null; debug?: boolean;
    /** NVIDIA NRAS verdict on the GPU evidence: null = not checked (no key, or NRAS unreachable). */
    gpu_verified?: boolean | null; gpu_error?: string; gpu_token?: string }[];
  gateway_tdx_verified: boolean | null; verifier: string; checked_at: string;
  /** Every check ran and passed (false when the TDX verifier was not reachable — see the *_tdx_verified fields). */
  ok: boolean;
}

/** REPORTDATA (64 bytes) of an Intel TDX v4 quote: header 48 bytes + TD report body, report_data at body offset 520. */
export function quoteReportData(quoteHex: string): string {
  const q = Buffer.from(quoteHex, "hex");
  if (q.length < 632 || q.readUInt16LE(0) !== 4) throw new Error("not a TDX v4 quote");
  return q.subarray(568, 632).toString("hex");
}
/** MRCONFIGID (48 bytes) of the TD report body. */
export function quoteMrConfigId(quoteHex: string): string { return Buffer.from(quoteHex, "hex").subarray(48 + 184, 48 + 232).toString("hex"); }

type FetchFn = typeof fetch;

/** TD report body (quote v4: 48-byte header first): td_attributes @120, MRCONFIGID @184, RTMR3 @472. */
const tdBody = (quoteHex: string) => {
  const q = Buffer.from(quoteHex, "hex");
  if (q.length < 632 || q.readUInt16LE(0) !== 4) throw new Error("not a TDX v4 quote");
  return q.subarray(48, 48 + 584);
};
/** The TD runs in debug mode (td_attributes bit 0): its memory is readable by the host, so nothing it says is private. */
export const quoteIsDebug = (quoteHex: string) => (tdBody(quoteHex)[120]! & 1) === 1;
type EventLogEntry = { imr?: number; event_type?: number; event?: string; event_payload?: string; digest?: string };
const parsed = <T>(x: unknown): T | undefined => (typeof x === "string" ? (JSON.parse(x) as T) : (x as T | undefined));
/** MRCONFIGID must be 01 ‖ sha256(exact app_compose bytes) ‖ 15 zero bytes. */
export function configMatches(quoteHex: string, appCompose: string): boolean {
  const want = Buffer.concat([Buffer.from([1]), createHash("sha256").update(appCompose, "utf8").digest(), Buffer.alloc(15)]);
  return tdBody(quoteHex).subarray(184, 232).equals(want);
}
/** Replays the imr-3 events: digest = sha384(type as u32 LE ‖ ":" ‖ event ‖ ":" ‖ payload), RTMR3 = sha384(RTMR3 ‖ digest). */
export function rtmr3Matches(quoteHex: string, eventLog: EventLogEntry[]): boolean {
  let r = Buffer.alloc(48);
  for (const e of eventLog) {
    if (e.imr !== 3) continue;
    const t = Buffer.alloc(4); t.writeUInt32LE(e.event_type ?? 0);
    const d = createHash("sha384").update(Buffer.concat([t, Buffer.from(":"), Buffer.from(e.event ?? "", "utf8"), Buffer.from(":"), Buffer.from(e.event_payload ?? "", "hex")])).digest();
    if (e.digest && e.digest.toLowerCase() !== d.toString("hex")) return false;
    r = createHash("sha384").update(Buffer.concat([r, d])).digest();
  }
  return tdBody(quoteHex).subarray(472, 520).equals(r);
}
type Measured = { intel_quote?: string; event_log?: unknown; info?: { tcb_info?: unknown; compose_hash?: string } };
function measurements(a: Measured): { compose: boolean; rtmr3: boolean; debug: boolean } {
  const q = a.intel_quote ?? "";
  const tcb = parsed<{ app_compose?: string }>(a.info?.tcb_info);
  const log = parsed<EventLogEntry[]>(a.event_log) ?? [];
  const ok = <T>(f: () => T, d: T) => { try { return f(); } catch { return d; } };
  return { compose: typeof tcb?.app_compose === "string" && ok(() => configMatches(q, tcb.app_compose!), false),
    rtmr3: log.length > 0 && ok(() => rtmr3Matches(q, log), false), debug: ok(() => quoteIsDebug(q), true) };
}
export const NRAS_URL = "https://nras.attestation.nvidia.com";

const b64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
/** Verifies one NRAS JWT (ES384) against the JWKS; returns its claims, or throws. */
export function verifyNrasJwt(token: string, jwks: { keys: (JsonWebKey & { kid?: string })[] }): Record<string, unknown> {
  const [h, b, sig] = token.split(".");
  if (!h || !b || !sig) throw new Error("not a JWT");
  const header = JSON.parse(b64url(h).toString()) as { alg?: string; kid?: string };
  if (header.alg !== "ES384") throw new Error(`unexpected alg ${header.alg}`);
  const jwk = jwks.keys.find((k) => k.kid === header.kid) ?? (jwks.keys.length === 1 ? jwks.keys[0] : undefined);
  if (!jwk) throw new Error(`no NRAS key ${header.kid}`);
  const { kid: _kid, ...key } = jwk;
  const ok = createVerify("SHA384").update(`${h}.${b}`).verify({ key: createPublicKey({ key, format: "jwk" }), dsaEncoding: "ieee-p1363" }, b64url(sig));
  if (!ok) throw new Error("bad NRAS signature");
  const claims = JSON.parse(b64url(b).toString()) as Record<string, unknown>;
  if (typeof claims.exp === "number" && claims.exp * 1000 < Date.now() - 24 * 3600_000) throw new Error("NRAS token expired");
  return claims;
}

/** NVIDIA's verdict on a model's GPU evidence (`nvidia_payload` of a NEAR AI report). null = could not ask NVIDIA. */
export async function nrasVerify(nvidiaPayload: string, nonce: string, o: { apiKey: string; baseUrl?: string; fetch?: FetchFn }): Promise<{ verified: boolean | null; error?: string; token?: string }> {
  const base = (o.baseUrl ?? NRAS_URL).replace(/\/$/, ""), f = o.fetch ?? fetch;
  try {
    const p = JSON.parse(nvidiaPayload) as { nonce?: string; arch?: string; evidence_list?: { evidence?: string; certificate?: string }[] };
    const body = JSON.stringify({ nonce: p.nonce, arch: p.arch, evidence_list: (p.evidence_list ?? []).map((e) => ({ evidence: e.evidence, certificate: e.certificate })), claims_version: "3.0" });
    // NVIDIA's current docs use v4; the SDK still defaults to v3. Try v4, fall back to v3 when v4 is not there.
    const post = (v: string) => f(`${base}/${v}/attest/gpu`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${o.apiKey}` }, body, signal: AbortSignal.timeout(90_000) });
    let r = await post("v4");
    if (r.status === 404 || r.status === 405) r = await post("v3");
    if (!r.ok) return { verified: null, error: `NRAS ${r.status}${await r.text().then((t) => (/EP-\d+-\d+/.exec(t)?.[0] ? ` ${/EP-\d+-\d+/.exec(t)![0]}` : ""), () => "")}` };
    const jr = await f(`${base}/.well-known/jwks.json`, { signal: AbortSignal.timeout(30_000) });
    if (!jr.ok) return { verified: null, error: `NRAS JWKS ${jr.status}` };
    const jwks = (await jr.json()) as { keys: JsonWebKey[] };
    const out = (await r.json()) as unknown[];
    const main = (out.find((x) => Array.isArray(x) && x[0] === "JWT") as [string, string] | undefined)?.[1];
    if (!main) return { verified: false, error: "no overall token" };
    const claims = verifyNrasJwt(main, jwks);
    if (String(claims.eat_nonce ?? "").toLowerCase() !== nonce.toLowerCase()) return { verified: false, error: "nonce mismatch" };
    // Every per-GPU token must be signed by NVIDIA too.
    for (const x of out) if (x && typeof x === "object" && !Array.isArray(x)) for (const t of Object.values(x as Record<string, string>)) verifyNrasJwt(t, jwks);
    return claims["x-nvidia-overall-att-result"] === true ? { verified: true, token: main } : { verified: false, error: "overall result false", token: main };
  } catch (e) {
    const m = (e as Error).message;
    return /signature|alg|NRAS key|not a JWT|expired/.test(m) ? { verified: false, error: m } : { verified: null, error: m.slice(0, 200) };
  }
}
async function phalaVerify(quoteHex: string, fetchFn: FetchFn): Promise<boolean | null> {
  try {
    const r = await fetchFn("https://cloud-api.phala.network/api/v1/attestations/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hex: quoteHex }), signal: AbortSignal.timeout(60_000) });
    if (!r.ok) return null;
    const j = (await r.json()) as { success?: boolean; quote?: { verified?: boolean } };
    return j.success === true && j.quote?.verified === true;
  } catch { return null; }
}

/** A model's attestation as NEAR AI returns it: its own TEE models, or an attested third-party provider (Kimi K2.6
 * via Chutes, since Nov 2026) with another layout. */
interface RawModelAttestation {
  model_name?: string; signing_address?: string; request_nonce?: string; intel_quote?: string; nvidia_payload?: string;
  model?: string; provider?: string; nonce?: string; quote_b64?: string; e2e_pubkey?: string; gpu_evidence?: { evidence?: string; certificate?: string; arch?: string }[];
}
interface ModelEvidence { model: string; nonce: string; quote: string; bound: boolean; gpuNonce: string; gpuNonceOk: boolean; nvidiaPayload?: string;
  compose: boolean | null; rtmr3: boolean | null; debug: boolean }

function normalizeModel(m: RawModelAttestation, n: string): ModelEvidence {
  if (m.quote_b64) {
    // Third-party layout: REPORTDATA[0..32] = sha256(nonce hex ‖ e2e_pubkey base64), and every GPU's SPDM evidence
    // carries the same value as its requester nonce (bytes 4..36) — so quote, GPUs and our nonce are bound together.
    const quote = Buffer.from(m.quote_b64, "base64").toString("hex");
    const h = createHash("sha256").update(`${m.nonce ?? ""}${m.e2e_pubkey ?? ""}`).digest("hex");
    const ev = m.gpu_evidence ?? [];
    return {
      model: m.model ?? m.model_name ?? "?", nonce: (m.nonce ?? "").toLowerCase(), quote,
      bound: !!m.nonce && !!m.e2e_pubkey && quoteReportData(quote).startsWith(h),
      gpuNonce: h, gpuNonceOk: ev.length > 0 && ev.every((e) => Buffer.from(e.evidence ?? "", "base64").subarray(4, 36).toString("hex") === h),
      compose: null, rtmr3: null, debug: quoteIsDebug(quote),
      ...(ev.length ? { nvidiaPayload: JSON.stringify({ nonce: h, arch: ev[0]!.arch, evidence_list: ev }) } : {}),
    };
  }
  // NEAR AI's own layout: REPORTDATA = signing address ‖ our nonce; the GPU payload names our nonce.
  const rd = m.intel_quote ? quoteReportData(m.intel_quote) : "";
  const addr = (m.signing_address ?? "").replace(/^0x/, "").toLowerCase();
  const gpuNonce = (JSON.parse(m.nvidia_payload ?? "{}") as { nonce?: string }).nonce?.toLowerCase() ?? "";
  const meas = measurements(m as Measured);
  return { model: m.model_name ?? "?", nonce: (m.request_nonce ?? "").toLowerCase(), quote: m.intel_quote ?? "", bound: !!addr && rd.startsWith(addr) && rd.endsWith(n),
    gpuNonce: n, gpuNonceOk: gpuNonce === n, ...(m.nvidia_payload ? { nvidiaPayload: m.nvidia_payload } : {}), compose: meas.compose, rtmr3: meas.rtmr3, debug: meas.debug };
}

export async function checkNearAiReport(raw: string, nonce: string, opts: { fetch?: FetchFn; tdx?: boolean; now?: () => Date; nvidia?: { apiKey: string; baseUrl?: string } } = {}): Promise<ReportCheck> {
  const fetchFn = opts.fetch ?? fetch;
  const j = JSON.parse(raw) as {
    gateway_attestation?: { signing_address?: string; request_nonce?: string; intel_quote?: string; event_log?: unknown; info?: { compose_hash?: string; tcb_info?: unknown } };
    model_attestations?: RawModelAttestation[];
  };
  const g = j.gateway_attestation ?? {}, n = nonce.toLowerCase();
  const safe = <T>(f: () => T, d: T) => { try { return f(); } catch { return d; } };
  const gwRd = safe(() => quoteReportData(g.intel_quote ?? ""), "");
  // REPORTDATA = signing key (32 bytes; an ECDSA address is 20 bytes, zero-padded) ‖ our nonce (32 bytes).
  const gwKey = (g.signing_address ?? "").replace(/^0x/, "").toLowerCase();
  const gateway_bound = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(gwKey) && gwRd === `${gwKey.padEnd(64, "0")}${n}`;
  const gm = measurements(g);
  const compose_bound = gm.compose;
  const ms = (j.model_attestations ?? []).map((m) => safe(() => normalizeModel(m, n), { model: m.model_name ?? m.model ?? "?", nonce: "", quote: "", bound: false, gpuNonce: "", gpuNonceOk: false, compose: false, rtmr3: false, debug: true } as ModelEvidence));
  const nonce_ok = g.request_nonce?.toLowerCase() === n && ms.every((m) => m.nonce === n);
  const tdx = opts.tdx !== false;
  const models = await Promise.all(ms.map(async (m) => {
    const gpu = opts.nvidia && m.nvidiaPayload ? await nrasVerify(m.nvidiaPayload, m.gpuNonce, { ...opts.nvidia, fetch: fetchFn }) : { verified: null as boolean | null, error: opts.nvidia ? "no GPU evidence" : "no NVIDIA key" };
    return { model: m.model, bound: m.bound, gpu_nonce_ok: m.gpuNonceOk, tdx_verified: tdx && m.quote ? await phalaVerify(m.quote, fetchFn) : null,
      compose_bound: m.compose, rtmr3_ok: m.rtmr3, debug: m.debug,
      gpu_verified: gpu.verified, ...(gpu.error ? { gpu_error: gpu.error } : {}), ...("token" in gpu && gpu.token ? { gpu_token: gpu.token } : {}) };
  }));
  const gateway_tdx_verified = tdx && g.intel_quote ? await phalaVerify(g.intel_quote, fetchFn) : null;
  // ok only when every check ran and passed: an unreachable TDX verifier (null) is not a pass.
  // NVIDIA's verdict counts when we got one: a "no" fails the check, "could not ask" (null) leaves it to the others.
  // Measurements: required where the layout has them (null = a third-party layout without them); never a debug TD.
  const ok = nonce_ok && gateway_bound && compose_bound && gm.rtmr3 && !gm.debug && gateway_tdx_verified === true
    && models.every((m) => m.bound && m.gpu_nonce_ok && m.tdx_verified === true && m.gpu_verified !== false && m.compose_bound !== false && m.rtmr3_ok !== false && !m.debug);
  const gpuChecked = models.some((m) => m.gpu_verified === true);
  return { nonce_ok, gateway_bound, compose_bound, gateway_rtmr3_ok: gm.rtmr3, gateway_debug: gm.debug, models, gateway_tdx_verified, verifier: `nearchant attest-verify 3 + Phala DCAP${gpuChecked ? " + NVIDIA NRAS" : ""}`, checked_at: (opts.now?.() ?? new Date()).toISOString(), ok };
}
