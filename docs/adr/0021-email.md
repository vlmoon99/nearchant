# ADR 0021 — Email: sign-in links and order notices through Resend

Status: accepted (3 Nov 2026)

## Context
Owners could only sign in from the browser that holds their store key, or with a linked NEAR wallet. The Figma
onboarding has email sign-in, and owners should hear about new orders. A self-hosted mail server is not possible:
the Sparks' ISP blocks outgoing port 25 and a home IP lands in spam. Cloudflare's own sending needs a paid plan.

## Decision
- Send through **Resend** (free plan), domain `nearchant.com` verified there (DKIM/SPF in Cloudflare DNS), sender and
  API URL in `config/gateway.yaml` (`email.*`), key `RESEND_API_KEY` in the Keychain / the Spark's `.env`.
- The owner links an email in Settings with a **confirm link** (24 h); then "Email me a sign-in link" (15 min). Links
  are HMAC-signed tokens (session key), **single use**, open a page with one button (POST), so mail scanners that
  open links don't use them up. Unknown emails get the same answer as known ones. Rate limits: 3 per 15 min per
  store/email, 10 per hour per IP. Changing the email revokes the old one.
- A paid item order emails the owner (idempotency key `order-paid:<order>`); a failed email never blocks the sale.
- Every send: 10 s timeout, 3 tries with backoff on 429/5xx/network errors, Resend idempotency key.

## Consequences
- Receiving mail at `@nearchant.com` stays on Cloudflare Email Routing (forward to the owner's inbox).
- Free plan limits (about 100 emails a day) are enough for the hackathon; a paid plan or another provider is a
  config + key change.
- Buyers get no emails yet (checkout asks for no email address).
