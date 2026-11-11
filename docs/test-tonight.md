# Full test of nearchant.com: seller, buyer, and switching between them

The site runs on the Mac (Docker + the standby watchdog) on NEAR **testnet**: payments use free test nUSD, no real
money. Plan about 60–75 minutes; the AI part of a new store takes 10–15 minutes and runs while you do other steps.

## Before you start (2 min)

- The Mac stays on, plugged in, Docker Desktop running. `https://nearchant.com/health` should answer `ok`.
- Use **two browsers**, because a store's key lives in the browser that made it:
  - **A = seller**: Chrome on the Mac.
  - **B = buyer**: your phone (Safari), or a Chrome *Incognito* window.
- Use a real email you can open on the device you test with. Sign-in emails can land in spam.

## 1. Seller registers and lists items and services (Browser A, ~10 min + AI time)

1. Open `nearchant.com` → **Create your store** → **Start free**.
2. Choose **Both** (products and services). Name the store, e.g. "My Test Studio". Add a phone with the country code
   or an email, then tap **Continue**.
   ✅ About 10 s later: "Show us what you sell". A NEAR account `<name>.nearchant.testnet` was created.
3. Write one line about the store and add 2–4 photos, then tap **Continue**.
   ✅ "Getting to know you" fills with facts, then sales ideas, then 3 posts with pictures. This takes about
   10–15 min on NEAR AI. You can leave the tab open and go on to step 4 in another tab.
4. **Shop** (bottom bar on phones, sidebar on desktop) → **Products** → **Add a product**: title, price (e.g. 5),
   photo, then **Save**. ✅ It shows in the list, with **Share**.
5. **Shop** → **Services** → **Add a service**, e.g. "Photo shoot, 1 hour", price 10 → **Save**. ✅ Listed under Services.
6. **Settings** → **Email**: add your email and tap the link you receive.
   ✅ "Email linked". From now on **Sign in** → "Email me a sign-in link" works from any browser.
7. Open your store as buyers see it: **Settings → Open your store**, or `nearchant.com/h/<handle>/`.
   ✅ The product and the service are both there.

## 2. Buyer finds the store and buys, without an account first (Browser B, ~5 min)

1. Open `nearchant.com/feed`. Search for something your store sells, or open the store link from step 1.7.
2. Open the **product** → **Buy** → fill the delivery note → pay.
   ✅ A test wallet is made in this browser and gets free test nUSD. In about 10–20 s: "Paid — in escrow", then the
   order page with its timeline.
3. Tab **Orders** (phone) or **My orders** (desktop).
   ✅ The order is listed under "In this browser".

## 3. Buyer registers (Browser B, ~3 min)

1. Tap **Sign in** (bottom tab on phones, top right on desktop) → enter your email (**a different one** from the
   seller's) → **Email me a sign-in link** → open the email **on the same device** → **Sign in**.
   ✅ The tab now says **You**.
2. **Orders**. ✅ The order you paid before signing in now belongs to your account, so it shows on any device where
   you sign in.
3. Like a post (♥) and **Follow** the store. ✅ They show up under **Liked** and **Following**.

## 4. Seller ships, buyer confirms, money is released (A and B, ~3 min)

1. **A:** **Orders** → the new order → **Mark as shipped** (add a note).
   ✅ A progress bar at the bottom, then "Shipped". It can take up to ~30 s on NEAR.
2. **B:** open the order → **I got it — release payment**.
   ✅ "Released" within ~10 s.
3. **A:** **Wallet**. ✅ The balance went up by the price minus the 1% fee.
4. Optional: buy the **service** the same way, then try **Decline** / **Refund** on it in A.
   ✅ The buyer gets their money back.

## 5. Buyer becomes a seller, and switching between the two (Browser B, ~10 min)

1. Signed in as the buyer: tap **You** (phone) or your name (desktop).
   ✅ The account sheet starts with **Become a seller — "Open a free store… same sign-in"**.
   On desktop the header also has **Sell on Nearchant**.
2. Tap **Become a seller** → **Start free**.
   ✅ Your buyer email is already in the contact email, and a green line says "Signed in as … — your store will use
   the same sign-in".
3. Choose **Services**, name it, tap **Continue**, then add photos as in section 1.
   ✅ You are in the seller app of the new store.
4. **Switching:**
   - Desktop: the sidebar top has **Selling | Shopping**. Tap **Shopping** to go to the shop feed, where the header
     button now says **Your store**; tap it to go back.
   - Phone: the **⇄** button in the top bar goes to shopping. On the feed, the header pill says **Your store**, and
     **You** → **Switch to selling — <store name>** goes back. **Settings → Switch to shopping** works too.
   ✅ Each switch lands on the right page, and you stay signed in on both sides.
5. One sign-in for both: in a third browser (or after clearing site data), open `nearchant.com/app`, then **Email me
   a sign-in link** with the buyer email.
   ✅ It signs in to the new store. The buyer email was linked to it automatically.

## 6. Quick extra checks (optional, ~10 min)

- `nearchant.com/verify`: open a proof. ✅ "The post is unchanged".
- Report a post (⋯ → Report). ✅ "Thank you — we're checking it now".
- Phone dark mode: the pages stay readable.

## What to send back if something breaks

The page URL, the time, a screenshot, and the step number above (e.g. "4.1: stuck on 'Shipping…' for 2 min").

## Known limits today

- **AI is slow on NEAR AI:** onboarding to first posts takes about 10–15 min, because the Sparks are off.
- **Pictures and videos need Comfy Cloud credits.** If posts come without pictures, that's the credit, not the app.
- **It's testnet:** nUSD is a test token, and the yellow bar says so.
- **The Mac hosts the site.** If it sleeps or Docker quits, nearchant.com shows a Cloudflare error until the watchdog
  restarts it (≈2 min).

## Review copy in Russian / Ukrainian (for clients)

- Link now: **https://outlined-bureau-medal-stress.trycloudflare.com**. If it changed, read the new one with
  `docker logs nearchant-standby-review-tunnel-1 2>&1 | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | head -1`.
- The **EN | RU | UA** bar is at the top of every page, and the choice is remembered.
- It uses the same stores, orders and data as nearchant.com; only the interface language differs.
- Store names, posts and AI texts stay in the language they were written in.
- **If the link changes:** after a restart of `review-tunnel`, start the review gateway again with the new link:
  `cd ~/nearchant-standby/run && REVIEW_URL=<new link> docker compose -f compose.yaml --env-file .env --profile review up -d gateway-review`.
- To stop it: `docker compose -f compose.yaml --env-file .env --profile review stop`.
