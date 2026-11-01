import type { FC, PropsWithChildren } from "hono/jsx";
import type { HandleRecord } from "@nearchant/near";
import type { Service } from "@nearchant/db";

const Layout: FC<PropsWithChildren<{ title: string; testToken: boolean }>> = ({ title, testToken, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title}</title>
      <link rel="stylesheet" href="/assets/site.css" />
    </head>
    <body>
      {testToken ? <div class="test-banner">TEST network — payments use free nUSD test tokens</div> : null}
      <main>{children}</main>
      <footer>
        Powered by <a href="https://github.com/vlmoon99/nearchant">Nearchant</a> · payments settle on NEAR
      </footer>
    </body>
  </html>
);

export const CardPage: FC<{ handle: HandleRecord; services: Service[]; price: (units: string) => string; testToken: boolean; base: string; cfg: ClientConfig }> = ({ handle, services, price, testToken, base, cfg }) => (
  <Layout title={`${handle.card.name} · Nearchant`} testToken={testToken}>
    <section class="card">
      <h1>{handle.card.name}</h1>
      <p class="account">{handle.account_id}</p>
      {handle.card.bio ? <p class="bio">{handle.card.bio}</p> : null}
      {handle.card.links.length ? (
        <ul class="links">{handle.card.links.map((l) => <li><a href={l} rel="nofollow noopener">{new URL(l).host}</a></li>)}</ul>
      ) : null}
    </section>
    <section class="services">
      <h2>Services</h2>
      {services.length === 0 ? <p class="muted">Nothing listed yet.</p> : null}
      {services.map((s) => (
        <article class="service" data-service={s.id}>
          <header>
            <h3>{s.title}</h3>
            <span class="price">{price(s.priceUnits)}</span>
          </header>
          <p>{s.description}</p>
          <p class="muted">Delivered within {s.deliveryHours} h · paid into escrow, released when you accept</p>
          <form class="order" data-service={s.id}>
            <label>
              What do you need?
              <textarea name="brief" required maxlength={4000} rows={4} placeholder="Describe your project, audience and goal"></textarea>
            </label>
            <button type="submit">Order</button>
            <output class="result"></output>
          </form>
        </article>
      ))}
    </section>
    <PageConfig base={base} cfg={cfg} />
  </Layout>
);

export interface ClientConfig { rpcUrl: string; orders: string; network: string }

/** JSON config for /assets/checkout.js (a data block, not a script: CSP-safe). */
const PageConfig: FC<{ base: string; cfg: ClientConfig }> = ({ base, cfg }) => (
  <>
    <script type="application/json" id="nc-config" dangerouslySetInnerHTML={{ __html: JSON.stringify({ base, ...cfg }).replaceAll("<", "\\u003c") }}></script>
    <script type="module" src="/assets/checkout.js"></script>
  </>
);

export interface OrderView {
  orderId: string;
  handle: HandleRecord;
  serviceTitle: string;
  amountDisplay: string;
  state: string;
  chainStatus: string | null;
  revisionsLeft: boolean;
  stepsDone: string[];
  files: { kind: string; url: string }[];
  stopped: string | null;
}

const STEP_LABELS: Record<string, string> = {
  brief: "Understanding your brief", research: "Researching the market", council: "Agent council agreeing on the story",
  write: "Writing the slides", design: "Designing the cover", review: "Independent review", render: "Rendering PDF and PPTX", deliver: "Recording proof on NEAR",
};

export const OrderPage: FC<{ o: OrderView; base: string; cfg: ClientConfig; testToken: boolean }> = ({ o, base, cfg, testToken }) => {
  const html = o.files.find((f) => f.kind === "html");
  const working = ["paid", "in_progress"].includes(o.state) && o.chainStatus !== "Delivered";
  return (
    <Layout title={`Order ${o.orderId} · ${o.handle.card.name}`} testToken={testToken}>
      <section class="card">
        <p class="muted"><a href={base}>← {o.handle.card.name}</a></p>
        <h1>{o.serviceTitle}</h1>
        <p class="account">Order {o.orderId} · {o.amountDisplay} · escrow: {o.chainStatus ?? "not paid yet"}</p>
      </section>
      {o.stopped ? <section class="service"><h2>Stopped</h2><p>{o.stopped}</p><p class="muted">Your payment stays in escrow and is refundable after the delivery deadline.</p></section> : null}
      {working ? (
        <section class="service" data-poll-order={o.orderId}>
          <h2>Agents are working</h2>
          <ol class="steps">
            {Object.entries(STEP_LABELS).map(([k, label]) => <li class={o.stepsDone.includes(k) ? "done" : ""}>{label}</li>)}
          </ol>
          <p class="muted">This page refreshes by itself.</p>
        </section>
      ) : null}
      {o.state === "awaiting_payment" ? <section class="service"><p>Waiting for payment.</p></section> : null}
      {o.files.length && ["Delivered", "Released", "RevisionRequested", "RefundRequested", "Disputed", "Refunded"].includes(o.chainStatus ?? "") ? (
        <section class="service">
          <h2>Your deck</h2>
          {html ? <iframe class="preview" src={html.url} sandbox="allow-scripts" title="Deck preview"></iframe> : null}
          <p>{o.files.filter((f) => f.kind !== "html").map((f) => <a class="dl" href={f.url}>{f.kind.toUpperCase()}</a>)}</p>
          {o.chainStatus === "Delivered" ? (
            <p class="actions">
              <button data-order-action="accept" data-order={o.orderId}>Accept and release payment</button>
              {o.revisionsLeft
                ? <button class="secondary" data-order-action="request_revision" data-order={o.orderId}>Request a revision</button>
                : <button class="secondary" data-order-action="request_refund" data-order={o.orderId}>Request a refund</button>}
            </p>
          ) : null}
          {o.chainStatus === "Released" ? <p>Accepted. The payment was released to {o.handle.account_id}.</p> : null}
          <output id="order-msg"></output>
        </section>
      ) : null}
      <PageConfig base={base} cfg={cfg} />
    </Layout>
  );
};

export const NotFoundPage: FC<{ testToken: boolean }> = ({ testToken }) => (
  <Layout title="No shop here · Nearchant" testToken={testToken}>
    <section class="card">
      <h1>No shop here</h1>
      <p class="muted">This handle is not claimed, or the shop is suspended.</p>
    </section>
  </Layout>
);

export const SITE_CSS = `
:root { --bg:#fbfaf7; --fg:#1d1c1a; --muted:#6b6862; --line:#e6e2da; --accent:#1f6f5c; --warn:#fff3c4; }
@media (prefers-color-scheme: dark) { :root { --bg:#151514; --fg:#ecebe7; --muted:#a19d95; --line:#2c2b28; --accent:#5cc4a6; --warn:#3a3214; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; }
main { max-width: 720px; margin: 0 auto; padding: 24px 16px 48px; }
.test-banner { background: var(--warn); text-align:center; padding:6px 16px; font-size:14px; }
h1 { font-size: 32px; margin: 8px 0 0; } h2 { font-size: 20px; margin: 32px 0 12px; } h3 { margin:0; font-size:18px; }
.account { color: var(--muted); font-family: ui-monospace, monospace; font-size: 14px; margin: 4px 0 12px; }
.links { list-style:none; padding:0; display:flex; gap:12px; flex-wrap:wrap; }
a { color: var(--accent); }
.muted { color: var(--muted); font-size: 14px; }
.service { border:1px solid var(--line); border-radius: 12px; padding: 16px; margin: 12px 0; }
.service header { display:flex; justify-content:space-between; gap:12px; align-items:baseline; }
.price { font-weight: 600; white-space: nowrap; }
form.order { display:grid; gap:8px; margin-top: 12px; }
label { display:grid; gap:4px; font-size:14px; }
input, textarea { width:100%; font:inherit; padding:8px; border-radius:8px; border:1px solid var(--line); background:transparent; color:inherit; }
button { justify-self:start; font:inherit; padding:8px 16px; border-radius:8px; border:0; background:var(--accent); color:#fff; cursor:pointer; }
output { font-size:14px; white-space: pre-wrap; }
.steps li { color: var(--muted); } .steps li.done { color: var(--fg); } .steps li.done::marker { content: '✓  '; }
.preview { width:100%; aspect-ratio: 16/9; border:1px solid var(--line); border-radius:8px; background:#fff; }
.dl { display:inline-block; margin-right:12px; font-weight:600; }
.actions { display:flex; gap:8px; flex-wrap:wrap; }
button.secondary { background: transparent; color: var(--accent); border:1px solid var(--accent); }
button:disabled { opacity:.6; cursor: default; }
footer { text-align:center; color:var(--muted); font-size:13px; padding: 24px 16px; }
`;

export const NewShopPage: FC<{ cfg: ClientConfig; testToken: boolean; enabled: boolean }> = ({ cfg, testToken, enabled }) => (
  <Layout title="Create your shop · Nearchant" testToken={testToken}>
    <section class="card">
      <h1>Create your shop</h1>
      <p class="bio">Your own NEAR account and web address, plus an agent team that sells and delivers pitch decks for you.
        Free on testnet — no wallet needed.</p>
    </section>
    {enabled ? (
      <form id="new-shop" class="service order">
        <label>Handle <input name="handle" required pattern="[a-z0-9][a-z0-9_-]{0,30}[a-z0-9]" placeholder="bob" autocomplete="off" />
          <span class="muted" id="handle-hint">becomes bob.nearchant.testnet</span></label>
        <label>Shop name <input name="name" required maxlength={80} placeholder="Bob's Decks" /></label>
        <label>One paragraph about you <textarea name="bio" maxlength={600} rows={3} placeholder="Who you help and why buyers trust you"></textarea></label>
        <label>Price for a pitch deck (nUSD) <input name="price" type="number" min="0.5" max="100" step="0.5" value="5" /></label>
        <button type="submit">Create my shop</button>
        <output class="result"></output>
        <p class="muted">Your account key is created in this browser and stays here (download it after). Nearchant keeps only
          agent keys that can deliver orders and record proofs — never move your money.</p>
      </form>
    ) : <p class="muted">Shop creation is off on this gateway.</p>}
    <PageConfig base="/" cfg={cfg} />
  </Layout>
);

export const ManagePage: FC<{ handle: HandleRecord; cfg: ClientConfig; testToken: boolean }> = ({ handle, cfg, testToken }) => (
  <Layout title={`Manage ${handle.card.name} · Nearchant`} testToken={testToken}>
    <section class="card">
      <p class="muted"><a href={`/h/${handle.handle}/`}>← {handle.card.name}</a></p>
      <h1>Manage your shop</h1>
      <p class="account">{handle.account_id}</p>
    </section>
    <form id="tg-connect" class="service order" data-handle={handle.handle}>
      <h2>Telegram bot</h2>
      <p class="muted">Create a bot with @BotFather, paste its token here. Buyers can then chat with your agent and order from Telegram.</p>
      <label>Bot token <input name="token" required autocomplete="off" placeholder="123456789:AA…" /></label>
      <label>Your account key <input name="key" autocomplete="off" placeholder="ed25519:… (filled in automatically if this browser created the shop)" /></label>
      <button type="submit">Connect bot</button>
      <output class="result"></output>
    </form>
    <PageConfig base={`/h/${handle.handle}/`} cfg={cfg} />
  </Layout>
);
