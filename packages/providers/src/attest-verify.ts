// Checks a NEAR AI attestation report (GET /v1/attestation/report?model=&nonce=) as far as we can without trusting
// NEAR AI: freshness (our nonce comes back), binding (the TDX quote's REPORTDATA = NEAR AI's signing key ‖ our nonce,
// the model's quote = its signing address ‖ our nonce, the quote's MRCONFIGID carries the app's compose hash), the
// Intel TDX quote itself (Phala's public DCAP verifier), and that the NVIDIA GPU evidence is for our nonce.
// NVIDIA's own verifier (NRAS) answers 403 without an API key, so the GPU evidence is not checked by NVIDIA here.
export interface ReportCheck {
  nonce_ok: boolean; gateway_bound: boolean; compose_bound: boolean;
  models: { model: string; bound: boolean; gpu_nonce_ok: boolean; tdx_verified: boolean | null }[];
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
async function phalaVerify(quoteHex: string, fetchFn: FetchFn): Promise<boolean | null> {
  try {
    const r = await fetchFn("https://cloud-api.phala.network/api/v1/attestations/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hex: quoteHex }), signal: AbortSignal.timeout(60_000) });
    if (!r.ok) return null;
    const j = (await r.json()) as { success?: boolean; quote?: { verified?: boolean } };
    return j.success === true && j.quote?.verified === true;
  } catch { return null; }
}

export async function checkNearAiReport(raw: string, nonce: string, opts: { fetch?: FetchFn; tdx?: boolean; now?: () => Date } = {}): Promise<ReportCheck> {
  const fetchFn = opts.fetch ?? fetch;
  const j = JSON.parse(raw) as {
    gateway_attestation?: { signing_address?: string; request_nonce?: string; intel_quote?: string; info?: { compose_hash?: string } };
    model_attestations?: { model_name?: string; signing_address?: string; request_nonce?: string; intel_quote?: string; nvidia_payload?: string }[];
  };
  const g = j.gateway_attestation ?? {}, n = nonce.toLowerCase();
  const safe = <T>(f: () => T, d: T) => { try { return f(); } catch { return d; } };
  const gwRd = safe(() => quoteReportData(g.intel_quote ?? ""), "");
  const gateway_bound = !!g.signing_address && gwRd === `${g.signing_address}${n}`.toLowerCase();
  const compose_bound = !!g.info?.compose_hash && safe(() => quoteMrConfigId(g.intel_quote ?? ""), "").includes(g.info.compose_hash.toLowerCase());
  const nonce_ok = g.request_nonce?.toLowerCase() === n && (j.model_attestations ?? []).every((m) => m.request_nonce?.toLowerCase() === n);
  const tdx = opts.tdx !== false;
  const models = await Promise.all((j.model_attestations ?? []).map(async (m) => {
    const rd = safe(() => quoteReportData(m.intel_quote ?? ""), "");
    const addr = (m.signing_address ?? "").replace(/^0x/, "").toLowerCase();
    const bound = !!addr && rd.startsWith(addr) && rd.endsWith(n);
    const gpu_nonce_ok = safe(() => (JSON.parse(m.nvidia_payload ?? "{}") as { nonce?: string }).nonce?.toLowerCase() === n, false);
    return { model: m.model_name ?? "?", bound, gpu_nonce_ok, tdx_verified: tdx && m.intel_quote ? await phalaVerify(m.intel_quote, fetchFn) : null };
  }));
  const gateway_tdx_verified = tdx && g.intel_quote ? await phalaVerify(g.intel_quote, fetchFn) : null;
  // ok only when every check ran and passed: an unreachable TDX verifier (null) is not a pass.
  const ok = nonce_ok && gateway_bound && compose_bound && models.every((m) => m.bound && m.gpu_nonce_ok && m.tdx_verified === true) && gateway_tdx_verified === true;
  return { nonce_ok, gateway_bound, compose_bound, models, gateway_tdx_verified, verifier: "nearchant attest-verify 1 + Phala DCAP", checked_at: (opts.now?.() ?? new Date()).toISOString(), ok };
}
