// Story cards for the X thread and the submission (docs/new-era.md): one 1600×900 PNG per step, the screenshot on
// the right, what happens underneath on the left.
//   node e2e/story-cards.mjs <journeyShotsDir> <publicShotsDir> <originalPhoto> <aiPicture> <outDir>
// journeyShotsDir: from e2e/journey.sh; publicShotsDir: landing.png, verify-93.png, feed.png (desktop 2×, phone 2×).
import { mkdirSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { chromium } from "playwright-core";

const [journey, pub, original, aiPicture, out] = process.argv.slice(2);
if (!out) throw new Error("usage: story-cards.mjs <journeyDir> <publicDir> <originalPhoto> <aiPicture> <outDir>");
mkdirSync(out, { recursive: true });
const uri = (f) => {
  const b = readFileSync(f);
  const t = b.subarray(8, 12).toString() === "WEBP" ? "webp" : { ".jpg": "jpeg", ".jpeg": "jpeg" }[extname(f)] ?? "png";
  return `data:image/${t};base64,${b.toString("base64")}`;
};

const phone = (f, top = 0) => `<div class="phone"><img src="${uri(f)}" style="margin-top:-${top}px"></div>`;
const desk = (f, top = 0, zoom = 1, left = 0) => `<div class="desk"><img src="${uri(f)}" style="margin-top:-${top}px;width:${zoom * 100}%;max-width:none;margin-left:-${left}px"></div>`;
const pills = (xs) => `<div class="pills">${xs.map(([k, t]) => `<span class="pill ${k}">${t}</span>`).join("")}</div>`;

const cards = [
  ["01-new-era", "A new era of web apps", "Private by default. Personal for everyone. Open to anyone.", `
    <div class="stack">
      <div class="box tee"><b>TEE backend</b><span>The whole server and database in a Phala Cloud Intel TDX machine. The cloud and the operator see only encrypted memory.</span></div>
      <div class="box ai"><b>TEE AI</b><span>NEAR AI Cloud models answer inside TEEs. We check each attestation ourselves.</span></div>
      <div class="box near"><b>NEAR</b><span>Escrow for every order, agent spend limits, a proof for every post.</span></div>
      <div class="box oss"><b>Open source</b><span>MIT. Anyone can read what the sealed machine runs, and copy it.</span></div>
    </div>`, [["tee", "Phala TDX"], ["ai", "NEAR AI TEE"], ["near", "NEAR testnet"], ["oss", "MIT"]], true],
  ["02-sell", "A seller starts in two minutes", "Says what they sell and adds a few photos. A NEAR account for the store is created in the browser: no seed phrase, no crypto knowledge.", phone(`${journey}/3-show.png`), [["near", "NEAR account per store"], ["tee", "Photos stay private until published"]]],
  ["03-learn", "The AI learns the store, privately", "A vision model reads the photos: products, style, buyers, what gets saves. It runs inside a NEAR AI TEE. The model router refuses to send private data to any model that isn't a TEE.", phone(`${journey}/4-learn.png`), [["ai", "NEAR AI TEE: Qwen3.6"], ["tee", "Private data → TEE only"]]],
  ["04-ideas", "Ways to sell more, with sources", "Trends only when a real web result backs them, plus price, bundles and channels, each with an honest monthly estimate.", phone(`${journey}/5-opps.png`), [["ai", "Web research inside the CVM"], ["oss", "Estimates, not promises"]]],
  ["05-picture", "The real product, in new scenes", "Left: the seller's photo. Right: the AI's picture of the same jacket, with a headline strip in the brand colour. A NEAR AI model checks that the caption invents no offers.", `
    <div class="pair"><figure><img src="${uri(original)}"><figcaption>Seller's photo</figcaption></figure><figure><img src="${uri(aiPicture)}"><figcaption>AI post picture</figcaption></figure></div>`, [["ai", "Caption check: Levanto Sage"], ["oss", "Pictures: Comfy Cloud (public tier)"]]],
  ["06-proof", "Every post gets a proof on NEAR", "Its fingerprint, the store's own key, the caption check, and the TEE attestation of the model that wrote it: our nonce and NEAR AI's key inside a verified Intel TDX quote. Anyone can re-check it.", desk(`${pub}/verify-93.png`, 390, 1.98, 368), [["near", "proofs.nearchant.testnet"], ["ai", "TDX quote verified"]]],
  ["07-pay", "A buyer pays into escrow", "A test wallet is made in the buyer's browser. The money waits in an escrow contract on NEAR, not with the store and not with us.", phone(`${journey}/paid.png`), [["near", "orders.nearchant.testnet"], ["near", "nUSD (test token)"]]],
  ["08-released", "Shipped, confirmed, released", "The shipment is recorded on chain. The buyer's confirmation, or a timeout, releases the money to the store. Agents act with function-call keys only, under on-chain limits.", phone(`${journey}/released.png`), [["near", "Escrow → store"], ["tee", "Agents can't move funds freely"]]],
  ["09-take-it", "Take it as your core", "This is a testnet prototype with an honest list of what's private today and what's next (docs/new-era.md). Take the whole stack, 16 copy-paste kits, or just the architecture.", `
    <div class="stack">
      <div class="box oss"><b>Whole stack</b><span>deploy/phala/compose.yaml · config/providers.cloud.yaml · 6 NEAR contracts with sandbox tests</span></div>
      <div class="box near"><b>16 kits</b><span>escrow · checkout · NEAR wallet login · proof log · caption check · store profile · moderation …</span></div>
      <div class="box ai"><b>Try it</b><span>nearchant.com/start · nearchant.com/verify/93</span></div>
      <div class="box tee"><b>Code</b><span>github.com/vlmoon99/nearchant</span></div>
    </div>`, [["oss", "MIT"], ["near", "NEAR testnet"]], true],
];

const css = `
  *{box-sizing:border-box;margin:0}
  body{width:1600px;height:900px;font-family:-apple-system,"SF Pro Display","Inter",system-ui,sans-serif;background:#0b1020;color:#e9edf7;display:flex;overflow:hidden}
  .left{width:700px;padding:72px 56px 56px 72px;display:flex;flex-direction:column}
  .brand{display:flex;align-items:center;gap:12px;font-weight:600;font-size:22px;color:#c9d2e8}
  .logo{width:34px;height:34px;border-radius:9px;background:#111;color:#2bd67b;display:grid;place-items:center;font-weight:800;border:1px solid #2a3350}
  .step{margin-left:auto;font-variant-numeric:tabular-nums;color:#7d89a8;font-size:20px}
  h1{font-size:54px;line-height:1.08;letter-spacing:-.02em;margin-top:64px;color:#fff}
  p{font-size:26px;line-height:1.45;color:#b8c2da;margin-top:28px}
  .pills{margin-top:auto;display:flex;flex-wrap:wrap;gap:10px}
  .pill{font-size:18px;padding:8px 14px;border-radius:999px;border:1px solid}
  .tee{--c:#a78bfa}.ai{--c:#38bdf8}.near{--c:#34d399}.oss{--c:#fbbf24}
  .pill{color:var(--c);border-color:color-mix(in srgb,var(--c) 45%,transparent);background:color-mix(in srgb,var(--c) 10%,transparent)}
  .right{flex:1;display:grid;place-items:center;padding:48px 64px 48px 0;background:radial-gradient(circle at 60% 50%,#1b2547 0,#0b1020 70%)}
  .phone{width:393px;height:780px;border-radius:44px;overflow:hidden;border:10px solid #1d2438;box-shadow:0 30px 80px #0009;background:#fff}
  .phone img{width:100%;display:block}
  .desk{width:820px;height:780px;border-radius:16px;overflow:hidden;border:1px solid #2a3350;box-shadow:0 30px 80px #0009;background:#fff}
  .desk img{width:100%;display:block}
  .pair{display:flex;gap:24px}
  .pair figure{width:380px}
  .pair img{width:100%;height:560px;object-fit:cover;border-radius:16px;display:block;box-shadow:0 30px 80px #0009}
  .pair figcaption{margin-top:14px;font-size:20px;color:#9aa6c4;text-align:center}
  .stack{display:grid;gap:18px;width:780px}
  .box{border:1px solid color-mix(in srgb,var(--c) 45%,transparent);background:color-mix(in srgb,var(--c) 8%,#0f1630);border-radius:18px;padding:22px 26px;display:flex;flex-direction:column;gap:6px}
  .box b{font-size:28px;color:var(--c)}
  .box span{font-size:21px;line-height:1.4;color:#c6cfe4}
  .hero h1{font-size:64px}`;

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
for (const [i, [name, title, body, right, tags, hero]] of cards.entries()) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body class="${hero ? "hero" : ""}">
    <div class="left"><div class="brand"><span class="logo">N</span>Nearchant<span class="step">${String(i + 1).padStart(2, "0")} / ${String(cards.length).padStart(2, "0")}</span></div>
    <h1>${title}</h1><p>${body}</p>${pills(tags)}</div><div class="right">${right}</div></body></html>`;
  await page.setContent(html, { waitUntil: "load" });
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log(`${out}/${name}.png`);
}
await browser.close();
