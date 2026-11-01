// Page routes of the seller app (ADR 0018). JSON lives in seller-app.ts; these render the Figma screens.
import type { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { OnboardingPage } from "./onboarding.js";
import type { UiConfig } from "./kit.js";
import { readSession } from "../seller-app.js";

export interface UiDeps { cfg: UiConfig; test: boolean; css: string; js: string | undefined; sessionKey: Buffer }

export function mountUi(app: Hono<any>, d: UiDeps): void {
  app.get("/assets/ui.css", (c) => c.body(d.css, 200, { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=300" }));
  app.get("/assets/app.js", (c) => (d.js ? c.body(d.js, 200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300" }) : c.text("app.js not built", 503)));
  app.get("/start", (c) => c.html(<OnboardingPage cfg={d.cfg} test={d.test} />));
  // Dashboard pages come in step 10; until then a signed-in owner continues onboarding.
  app.get("/app", (c) => c.redirect(readSession(d.sessionKey, getCookie(c, "nc_session")) ? "/start" : "/start", 302));
}
