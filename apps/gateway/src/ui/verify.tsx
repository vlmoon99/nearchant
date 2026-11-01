// "Verify a post" (landing nav, Figma Landing): anyone checks a post's proof on NEAR without trusting Nearchant —
// the entry is read from the proof-log contract, the fingerprint is recomputed from the published caption and the
// published picture file, and the TEE attestation check is linked.
import type { FC } from "hono/jsx";
import { Badge, Icon, Mark, UiPage, type UiConfig } from "./kit.js";

export interface VerifyView {
  proofId: string; found: boolean;
  author?: string; createdAt?: string; producer?: string; outputHash?: string; recomputed?: string | null; match?: boolean | null;
  reviewPassed?: boolean | null; attestation?: { model: string; hash: string; ok: boolean | null } | null;
  post?: { caption: string; img: string | null; store: string; href: string } | null;
  contractUrl: string;
}

const Row: FC<{ ok: boolean | null | undefined; title: string; detail: string }> = ({ ok, title, detail }) => (
  <div class="row" style="gap:12px;align-items:flex-start">
    <span class={`dot ${ok ? "ok" : ok === false ? "" : "todo"}`} style={`width:26px;height:26px;flex:none;${ok === false ? "background:#ff3b30;color:#fff" : ""}`}>{ok ? <Icon n="check" s={14} /> : ok === false ? "✕" : "?"}</span>
    <span class="stack" style="gap:2px;min-width:0"><span class="callout b">{title}</span><span class="foot muted" style="word-break:break-all">{detail}</span></span>
  </div>
);

export const VerifyPage: FC<{ cfg: UiConfig; test: boolean; v: VerifyView | null; latest: { id: string; store: string; caption: string }[] }> = ({ cfg, test, v, latest }) => (
  <UiPage title={v ? `Proof #${v.proofId} · Nearchant` : "Verify a post · Nearchant"} cfg={cfg} page="verify" test={test}>
    <div class="land">
      <nav class="land-nav"><a class="land-logo" href="/"><Mark />Nearchant</a><a class="btn" href="/start">Create your store</a></nav>
      <section class="stack" style="max-width:760px;margin:0 auto;padding:40px 16px 80px;gap:20px">
        <h1 class="t1">Verify a post</h1>
        <p class="body muted" style="margin:0">Every published post has a proof on NEAR: a fingerprint of its caption and picture, who published it, when, and which AI wrote it. Check one here — the page reads NEAR directly.</p>
        <form class="row" style="gap:10px" action="/verify" method="get">
          <input class="input" name="id" inputmode="numeric" placeholder="Proof number, e.g. 21" value={v?.proofId ?? ""} style="flex:1" />
          <button class="btn" type="submit"><Icon n="shield" />Check</button>
        </form>
        {v && !v.found ? <div class="card"><span class="headline">No proof #{v.proofId} on NEAR</span><span class="foot muted">The number may be wrong — proofs are numbered from 0.</span></div> : null}
        {v?.found ? <>
          <div class="card proof" style="gap:14px">
            <div class="spread"><span class="headline proof-t">Proof #{v.proofId} on NEAR</span>{v.match ? <Badge label="Verified · unchanged" /> : null}</div>
            {v.post ? <div class="row" style="gap:14px;align-items:center">
              {v.post.img ? <span style={`width:96px;height:120px;border-radius:12px;flex:none;background:#eee center/cover url('${v.post.img}')`}></span> : null}
              <span class="stack" style="gap:6px;min-width:0"><a class="headline" href={v.post.href}>{v.post.store}</a><span class="foot clamp3">{v.post.caption}</span></span>
            </div> : null}
          </div>
          <div class="card" style="gap:16px">
            <Row ok={v.match} title={v.match ? "The post is unchanged" : v.match === false ? "The post was changed after the proof" : "Fingerprint not recomputed"}
              detail={`On NEAR: ${v.outputHash}${v.recomputed ? ` · from the published post now: ${v.recomputed}` : ""}`} />
            <Row ok={true} title={`Published by ${v.author}`} detail={`Signed by that account's own key${v.createdAt ? ` · ${v.createdAt}` : ""}`} />
            <Row ok={v.reviewPassed ?? null} title={v.reviewPassed ? "Caption check passed" : v.reviewPassed === false ? "Caption check flagged an offer" : "No caption check"} detail="Levanto Sage (NEAR AI) looked for discounts, gifts, deadlines or prices the store never stated" />
            <Row ok={v.attestation ? v.attestation.ok : null} title={v.attestation ? `Written by ${v.attestation.model} in a NEAR AI TEE` : `Made by ${v.producer ?? "the store's AI"}`}
              detail={v.attestation ? `Intel TDX quote verified, NEAR AI's key and our nonce bound into it · report ${v.attestation.hash.slice(0, 12)}…` : "Ran on the store's own GPUs (no TEE report)"} />
            {v.attestation ? <span class="foot"><a href={`/attestations/${v.attestation.hash}.json`} target="_blank" rel="noopener">Attestation report</a> · <a href={`/attestations/${v.attestation.hash}.check.json`} target="_blank" rel="noopener">our check</a></span> : null}
            <a class="btn near" href={v.contractUrl} target="_blank" rel="noopener"><Icon n="globe" />See the proof-log contract on the NEAR explorer</a>
            <span class="cap muted">Check it yourself: <code>near view proofs.nearchant.testnet get '{`{"proof_id":"${v.proofId}"}`}'</code></span>
          </div>
        </> : null}
        {latest.length ? <div class="stack" style="gap:8px"><span class="headline">Latest proofs</span>
          {latest.map((l) => <a class="card white" style="flex-direction:row;gap:12px;padding:12px;color:inherit" href={`/verify/${l.id}`}><span class="b proof-t">#{l.id}</span><span class="foot clamp1" style="flex:1;min-width:0">{l.store} — {l.caption}</span></a>)}</div> : null}
      </section>
    </div>
  </UiPage>
);
