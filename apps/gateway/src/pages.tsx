import type { FC, PropsWithChildren } from "hono/jsx";
import type { HandleRecord } from "@nearchant/near";
import type { Service } from "./store.js";

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

export const CardPage: FC<{ handle: HandleRecord; services: Service[]; price: (units: string) => string; testToken: boolean; base: string }> = ({ handle, services, price, testToken, base }) => (
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
          <form class="order" data-service={s.id} data-base={base}>
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
    <script type="module" src="/assets/card.js"></script>
  </Layout>
);

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
textarea { width:100%; font:inherit; padding:8px; border-radius:8px; border:1px solid var(--line); background:transparent; color:inherit; }
button { justify-self:start; font:inherit; padding:8px 16px; border-radius:8px; border:0; background:var(--accent); color:#fff; cursor:pointer; }
output { font-size:14px; white-space: pre-wrap; }
footer { text-align:center; color:var(--muted); font-size:13px; padding: 24px 16px; }
`;

/** Card behaviour, served as a file so pages need no inline script (CSP: script-src 'self'). */
export const CARD_JS = `
for (const form of document.querySelectorAll("form.order")) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const out = form.querySelector("output");
    out.textContent = "Creating order…";
    const res = await fetch(form.dataset.base + "public/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serviceId: form.dataset.service, brief: form.brief.value }),
    });
    const j = await res.json();
    if (!res.ok) { out.textContent = j.error || "Something went wrong"; return; }
    let text = "Order " + j.orderId + " created. Pay " + j.amountDisplay + " to start.";
    if (j.anyChainQuote) text += "\\nFrom another chain via NEAR Intents it would cost about " + j.anyChainQuote.amountInFormatted + " " + j.anyChainQuote.label + ".";
    out.textContent = text;
  });
}
`;
