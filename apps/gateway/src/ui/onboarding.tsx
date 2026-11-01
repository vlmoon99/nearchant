// Onboarding (Figma row "Onboarding (mobile web)"): one page, steps shown one at a time by web/app.ts.
// Welcome → what you sell → show your business → getting to know you → opportunities → first posts → store live.
import type { FC } from "hono/jsx";
import { Badge, Icon, Mark, UiPage, type UiConfig } from "./kit.js";

const Dots: FC<{ step: number }> = ({ step }) => (
  <div class="spread"><span class="foot b muted">Step {step} of 5</span><span class="steps-dots">{[1, 2, 3, 4, 5].map((k) => <i class={`${k <= step ? "on" : ""} ${k === step ? "cur" : ""}`}></i>)}</span></div>
);

export const OnboardingPage: FC<{ cfg: UiConfig; test: boolean }> = ({ cfg, test }) => (
  <UiPage title="Start selling · Nearchant" cfg={cfg} page="onboarding" test={test}>
    {/* 1 Welcome */}
    <section class="onb" data-step="welcome">
      <a class="logo" style="padding:0"><Mark s={30} />Nearchant</a>
      <div class="card" style="gap:10px">
        <div class="row" style="gap:12px;align-items:center">
          <div style="width:76px;height:76px;border-radius:12px;background:linear-gradient(135deg,#c7d9ff,#2b3d80);flex:none"></div>
          <div class="stack s8"><span class="sub b">New drop: relaxed denim</span><span class="cap muted">Made by AI from 3 photos</span><Badge /></div>
        </div>
        <div class="card white" style="flex-direction:row;align-items:center;gap:10px;padding:12px;border:0;box-shadow:0 4px 12px rgba(0,0,0,.08)">
          <span class="dot ok"><Icon n="check" s={16} /></span><div class="stack" style="gap:2px"><span class="foot b">New sale · +45.00 USDC</span><span class="cap proof-t">Paid on NEAR · in escrow</span></div>
        </div>
      </div>
      <h1 class="tl" style="font-size:36px">Sell more.<br />Work less.<br />Get paid on NEAR.</h1>
      {[["sparkles", "#007AFF", "AI makes your posts from a few photos"], ["chart", "#AF52DE", "AI shows what sells, to whom and when"], ["shield", "#00A86B", "Buyers pay you directly — safe escrow on NEAR"]].map(([ic, c, t]) => (
        <div class="row" style="align-items:center;gap:12px"><span class="dot" style="background:var(--bg-2);border-radius:10px;width:34px;height:34px"><Icon n={ic!} c={c} /></span><span class="sub">{t}</span></div>
      ))}
      <div class="onb-bottom"><button class="btn" data-go="sell">Start free — 2 minutes</button><a class="sub" href="/app">I already have a store · Sign in</a></div>
    </section>

    {/* 2 What you sell */}
    <section class="onb hidden" data-step="sell">
      <Dots step={1} />
      <h1 class="tl">What do you sell?</h1>
      <p class="sub muted" style="margin:0">Nearchant works for things you ship and for services you do.</p>
      {[["box", "products", "Products", "Clothes, food, crafts, cosmetics, home goods"], ["users", "services", "Services", "Photo shoots, lessons, design, beauty, repairs"], ["layers", "both", "Both", "A shop plus your services"]].map(([ic, v, t, d], i) => (
        <label class={`option ${i === 0 ? "on" : ""}`} data-kind={v}><input type="radio" name="kind" value={v} checked={i === 0} class="hidden" /><span class="ic"><Icon n={ic!} s={22} /></span><span class="stack" style="gap:2px"><span class="headline">{t}</span><span class="foot muted">{d}</span></span></label>
      ))}
      <label class="field">Store name<input class="input" id="store-name" maxlength={60} placeholder="Nova Wear" autocomplete="organization" /></label>
      <span class="cap muted" id="store-link">Your store link: —</span>
      <output class="foot" id="sell-out"></output>
      <div class="onb-bottom"><button class="btn" id="create-store">Continue</button></div>
    </section>

    {/* 3 Show your business */}
    <section class="onb hidden" data-step="show">
      <Dots step={2} />
      <h1 class="tl">Show us what you sell</h1>
      <p class="sub muted" style="margin:0">A sentence, a link and a few photos. AI reads it in about 20 seconds.</p>
      <label class="field">In one sentence, what do you sell?<textarea class="input" id="biz-desc" maxlength={500} placeholder="Relaxed everyday clothes made in Kyiv — denim, knitwear and linen."></textarea></label>
      <label class="field">Instagram, Telegram channel or website (optional)<input class="input" id="biz-link" placeholder="instagram.com/yourstore" /></label>
      <span class="foot b">Product photos (2–8 work best)</span>
      <div class="thumbs" id="thumbs"><label class="th" style="display:grid;place-items:center;cursor:pointer;background:var(--bg-2)"><Icon n="plus" s={22} c="#6E6E73" /><input type="file" id="photo-input" accept="image/*" multiple class="hidden" /></label></div>
      <div class="card" style="flex-direction:row;gap:10px;padding:14px"><Icon n="lock" s={16} c="#6E6E73" /><span class="foot muted">We never post anything without your OK. Your photos stay private until you publish.</span></div>
      <output class="foot" id="show-out"></output>
      <div class="onb-bottom"><button class="btn" id="analyze"><Icon n="sparkles" />Analyze my business</button></div>
    </section>

    {/* 4 Getting to know you */}
    <section class="onb hidden" data-step="learn">
      <Dots step={3} />
      <h1 class="t2" id="learn-title">Getting to know your store…</h1>
      <div class="progress"><i id="learn-bar" style="width:10%"></i></div>
      <div class="stack s12" id="facts"></div>
      <p class="foot muted" id="learn-note">This is the moment AI turns your shop into a plan.</p>
    </section>

    {/* 5 Opportunities */}
    <section class="onb hidden" data-step="opps">
      <Dots step={4} />
      <h1 class="t2">We found <span id="opp-count">a few</span> ways to sell more</h1>
      <div class="card proof" style="flex-direction:row;align-items:center;gap:8px;padding:10px 14px"><Icon n="trend" c="#007A4F" /><span class="callout b proof-t" id="opp-total">≈ +0 USDC a month together</span></div>
      <div class="stack s12" id="opps"></div>
      <p class="cap faint">Estimates from your products and public market data — not promises.</p>
      <div class="onb-bottom"><button class="btn" id="make-posts"><Icon n="sparkles" />Use these — make my posts</button></div>
    </section>

    {/* 6 First posts */}
    <section class="onb hidden" data-step="posts">
      <Dots step={5} />
      <h1 class="t2" id="posts-title">Making your first posts…</h1>
      <p class="sub muted" style="margin:0">Made from the opportunities you picked. Change anything later, or schedule them all.</p>
      <div class="stack s12" id="first-posts"></div>
      <div class="card proof" style="flex-direction:row;gap:10px;padding:12px"><Icon n="shield" c="#007A4F" /><span class="foot">Each post gets a proof on NEAR when it goes live — buyers see it’s really yours.</span></div>
      <div class="onb-bottom"><button class="btn" id="schedule-all" disabled><Icon n="calendar" />Schedule all</button></div>
    </section>

    {/* 7 Store live */}
    <section class="onb hidden" data-step="live">
      <span class="dot ok" style="width:64px;height:64px"><Icon n="check" s={32} /></span>
      <h1 class="t2">Your store is live! 🎉</h1>
      <p class="sub muted" style="margin:0">Share the link — the first visitors are what get the first sale.</p>
      <div class="card" style="flex-direction:row;align-items:center"><div class="stack" style="gap:2px;flex:1"><span class="cap muted">Your store</span><a class="headline" id="store-url" href="#">—</a></div><button class="chip" id="copy-link"><Icon n="copy" s={14} />Copy</button></div>
      <div class="row" style="gap:10px"><a class="btn secondary" style="flex:1" id="share-tg" target="_blank" rel="noopener"><Icon n="send" />Telegram</a><a class="btn secondary" style="flex:1" id="share-wa" target="_blank" rel="noopener"><Icon n="msg" />WhatsApp</a></div>
      <div class="card dark" style="gap:8px"><div class="row" style="align-items:center;gap:8px"><span class="mark" style="background:var(--near);color:var(--near-ink)">N</span><span class="headline" style="color:var(--near)" id="near-account">—</span></div><span class="foot">Your NEAR account is ready — no seed phrase. Sales land here; escrow protects every buyer.</span><a class="foot" style="color:var(--near)" id="key-download" download>Download your account key (keep it safe)</a></div>
      <div class="onb-bottom"><a class="btn" href="/app">Go to my dashboard</a></div>
    </section>
  </UiPage>
);
