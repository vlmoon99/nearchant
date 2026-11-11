# 0029 — Russian and Ukrainian for review copies; production stays English

**Status:** accepted, 11 Nov 2026

## Context
The owner's Russian- and Ukrainian-speaking clients review the product. The hackathon build and nearchant.com are
English only, and a day before feature freeze there is no time to rewrite every page around message keys.

## Decision
- `UI_LANGS` (default `en`) is a deploy setting. With `en,ru,uk` the gateway:
  - adds a slim **EN | RU | UA** bar at the top of every HTML page (`?lang=` is remembered in a cookie, then the
    browser language is used);
  - puts `/assets/i18n/<lang>.js` first in `<head>`. The script translates interface text from `apps/gateway/i18n/<lang>.json`
    as the page is parsed and whatever the scripts add later, including placeholders, titles and alerts.
- **What is translated:** text that matches the dictionary. Patterns (`Step {0} of 5`), numbers and "·"-joined labels
  are handled too.
- **What stays as written:** store names, captions, AI-written text and emails.
- **Production** leaves `UI_LANGS` unset, so no page changes and `/assets/i18n/*` answers 404.
- **Dictionaries:**
  - `scripts/i18n-extract.mjs` collects the strings from the source: JSX text, literals, templates, and text with
    values inside one element.
  - The translations live in `i18n/parts/tr-*.json`, with hand fixes in `i18n/overrides.json`.
  - `scripts/i18n-merge.mjs` writes `ru.json` and `uk.json`.
  - `e2e/i18n-misses.mjs` lists interface text still in English on a review copy.
- **Review copy:**
  - `gateway-review` + `review-tunnel` in `deploy/standby/compose.yaml`, profile `review`.
  - It uses the same data with `STORE_SUBDOMAINS=off`, so store links stay on `/h/<handle>/`.
  - It is public through a Cloudflare quick tunnel, whose URL changes when the tunnel restarts.

## Consequences
- **Cost:** new interface strings need a dictionary entry: run the extract, translate the new keys, then merge.
  Until then they show in English.
- **Ambiguous words:** one English word gets one translation. Where meanings differ, the English changes; for
  example the item form says "Title", not "Name".
- **Not a production localisation:** emails, AI output and server error texts are English only.
