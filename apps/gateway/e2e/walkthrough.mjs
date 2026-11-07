// A recorded walkthrough of nearchant.com for the submission video (docs/demo-script.md):
//   1. desktop: landing → seller app of an existing store (Home, a post with its short + proof, Analytics, Wallet,
//      Settings → NEAR wallet), then the public "Verify a post" page (VERIFY_PROOF=<n>, e.g. one with a TEE-signed text)
//   2. phone: a live onboarding of a new store (AI waits sped up ×6)
//   3. phone: the storefront → an item → checkout form
//   4. phone: the shop feed — "denim jacket, knit sweater and whey protein" → Stores that sell it → a post → Ask the store
// Joined with ffmpeg into one 1440×900 mp4 (phone parts centred on a dark background).
//   node e2e/walkthrough.mjs <baseUrl> <sellerSessionToken> <storeHandle> <postId> [outDir]
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const [base, token, handle, postId, outDir = "/tmp/nc-walkthrough"] = process.argv.slice(2);
if (!base || !token || !handle || !postId) throw new Error("usage: walkthrough.mjs <baseUrl> <sessionToken> <storeHandle> <postId> [outDir]");
const photos = resolve(import.meta.dirname, "../../../fixtures/replay/store/photos");
rmSync(outDir, { recursive: true, force: true }); mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const host = new URL(base).hostname;
const pause = (p, ms) => p.waitForTimeout(ms);
const scroll = async (p, steps = 6, ms = 700) => { for (let i = 0; i < steps; i++) { await p.mouse.wheel(0, 380); await pause(p, ms); } };

async function segment(name, viewport, fn) {
  const dir = join(outDir, name);
  const ctx = await browser.newContext({ viewport, recordVideo: { dir, size: viewport }, deviceScaleFactor: 1 });
  await ctx.addCookies([{ name: "nc_session", value: token, domain: host, path: "/", secure: base.startsWith("https"), httpOnly: true }]);
  const page = await ctx.newPage();
  await fn(page, ctx);
  await ctx.close();
  const f = readdirSync(dir).find((x) => x.endsWith(".webm"));
  renameSync(join(dir, f), join(outDir, `${name}.webm`));
  console.log(`segment ${name} recorded`);
}

// 1 · desktop
await segment("1-desktop", { width: 1440, height: 900 }, async (p) => {
  await p.goto(base); await pause(p, 2500); await scroll(p, 8, 800);
  await p.goto(`${base}/app`); await pause(p, 2500); await scroll(p, 4);
  await p.goto(`${base}/app/posts/${postId}`); await pause(p, 2000);
  await p.evaluate(() => { const v = document.querySelector("video"); if (v) { v.muted = true; v.play(); } }); await pause(p, 6000); await scroll(p, 3);
  for (const u of ["/app/analytics", "/app/wallet", "/app/settings#wallet"]) { await p.goto(`${base}${u}`); await pause(p, 2500); await scroll(p, 2); }
  if (process.env.VERIFY_PROOF) { await p.goto(`${base}/verify/${process.env.VERIFY_PROOF}`); await pause(p, 3000); await scroll(p, 5, 1000); }
});

// 2 · phone onboarding (a new store; waits sped up later)
await segment("2-onboarding", { width: 393, height: 852 }, async (p, ctx) => {
  await ctx.clearCookies();
  const visible = (step, timeout) => p.waitForSelector(`[data-step=${step}]:not(.hidden)`, { timeout });
  await p.goto(`${base}/start`); await pause(p, 2000);
  await p.click("[data-go=sell]"); await pause(p, 800);
  await p.fill("#store-name", `Nova Demo ${Date.now().toString(36).slice(-3)}`); await pause(p, 800);
  await p.click("#create-store"); await visible("show", 120_000); await pause(p, 800);
  await p.fill("#biz-desc", "Relaxed everyday clothes designed in SoHo, New York — denim, linen and knitwear. We ship across the US.");
  await p.setInputFiles("#photo-input", readdirSync(photos).filter((f) => f.endsWith(".jpg")).map((f) => join(photos, f))); await pause(p, 1500);
  await p.click("#analyze"); await visible("opps", 600_000); await pause(p, 2500); await scroll(p, 2);
  await p.click("#make-posts"); await visible("posts", 60_000);
  await p.waitForSelector("#schedule-all:not([disabled])", { timeout: 900_000 }); await pause(p, 3000);
  await p.click("#schedule-all"); await visible("live", 120_000); await pause(p, 3000);
});

// 3 · phone buyer
await segment("3-buyer", { width: 393, height: 852 }, async (p, ctx) => {
  await ctx.clearCookies();
  await p.goto(`${base}/h/${handle}/`); await pause(p, 2500); await scroll(p, 4);
  const item = await p.$("a.post"); if (item) { await item.click(); await pause(p, 2000);
    await p.fill("form.order textarea", "Size M, Jane Doe, 120 Spring St, New York, NY 10012, +1 212 555 0100"); await pause(p, 2500); }
});

// 4 · phone: the shop feed (ADR 0022)
await segment("4-feed", { width: 393, height: 852 }, async (p, ctx) => {
  await ctx.clearCookies();
  await p.goto(`${base}/feed`); await pause(p, 1500);
  await p.fill("input[name=q]", "denim jacket, knit sweater and whey protein"); await pause(p, 600);
  await p.click(".feed-search button"); await p.waitForLoadState(); await pause(p, 3000);
  await scroll(p, 2, 900);
  const post = await p.$("a.feed-tile"); if (post) { await post.click(); await p.waitForLoadState(); await pause(p, 1500);
    const ask = await p.$("form[data-ask] input"); if (ask) { await ask.scrollIntoViewIfNeeded(); await ask.fill("Does it come in size L, and do you ship to Austin?"); await pause(p, 600);
      await p.click("form[data-ask] button"); await p.waitForFunction(() => { const o = document.querySelector("form[data-ask] output"); return o && o.textContent && !/Thinking/.test(o.textContent); }, null, { timeout: 60_000 }).catch(() => {}); await pause(p, 4000); } }
});

// Join: desktop as is; phone parts centred on 1440×900; onboarding sped up ×6 (it waits for the AI).
const ff = (args) => execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args]);
const norm = (name, speed = 1, phone = false) => {
  const vf = [speed !== 1 ? `setpts=PTS/${speed}` : null, phone ? "scale=-2:860,pad=1440:900:(ow-iw)/2:(oh-ih)/2:color=0x121916" : "scale=1440:900", "setsar=1,fps=30,format=yuv420p"].filter(Boolean).join(",");
  ff([...(phone ? ["-ss", "1.2"] : []), "-i", join(outDir, `${name}.webm`), "-vf", vf, "-an", "-c:v", "libx264", "-crf", "22", "-preset", "veryfast", join(outDir, `${name}.mp4`)]);
};
norm("1-desktop"); norm("2-onboarding", 6, true); norm("3-buyer", 1, true); norm("4-feed", 1, true);
ff(["-i", join(outDir, "1-desktop.mp4"), "-i", join(outDir, "2-onboarding.mp4"), "-i", join(outDir, "3-buyer.mp4"), "-i", join(outDir, "4-feed.mp4"),
  "-filter_complex", "[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0[v]", "-map", "[v]", "-c:v", "libx264", "-crf", "22", "-preset", "veryfast", "-movflags", "+faststart", join(outDir, "walkthrough.mp4")]);
console.log(`walkthrough: ${join(outDir, "walkthrough.mp4")}`);
await browser.close();
