// Collects the interface strings of the web app for the review translations (ru, uk; ADR 0029).
// JSX text, string literals and template literals (substitutions become {0}, {1}, …), and the text between tags
// inside HTML-building strings. Prints a JSON array of unique keys, whitespace collapsed.
//   node scripts/i18n-extract.mjs > i18n/keys.json
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const swc = require(require.resolve("@swc/core", { paths: [join(new URL("../../..", import.meta.url).pathname, "node_modules/.pnpm/@swc+core@1.16.21_@swc+helpers@0.5.23/node_modules")] }));

const here = new URL("..", import.meta.url).pathname;
const files = [
  ...readdirSync(join(here, "src/ui")).filter((f) => /\.tsx?$/.test(f)).map((f) => join(here, "src/ui", f)),
  ...["app.tsx", "buyer-app.ts", "seller-app.ts", "pages.tsx", "contact.ts", "banners.ts", "item-details.ts"].map((f) => join(here, "src", f)),
  ...["app.ts", "buyer.ts", "checkout.ts", "ui-bits.ts", "wallet.ts"].map((f) => join(here, "web", f)),
];
const keys = new Set();
const norm = (s) => s.replace(/\s+/g, " ").trim();
const ATTR = /\b(?:placeholder|title|aria-label|alt|label)=["']([^"'{}]+)["']/g;
function add(raw) {
  const s = norm(raw);
  if (s.length < 2 || !/[A-Za-z]{2}/.test(s)) return;
  if (/^[\w.-]+$/.test(s) && !/^[A-Z]/.test(s)) return;          // identifiers, classes
  if (/^[#.\[]|^\/|^https?:|=>|;\s*$|^[\w-]+:\s/.test(s)) return; // selectors, paths, code, css
  keys.add(s);
}
function fromHtml(s) {
  if (!s.includes("<")) { add(s); return; }
  for (const m of s.matchAll(ATTR)) add(m[1]);
  for (const part of s.replace(/<(script|style)[\s\S]*?<\/\1>/g, "").split(/<[^>]*>/)) add(part);
}
for (const f of files) {
  let src; try { src = readFileSync(f, "utf8"); } catch { continue; }
  const ast = swc.parseSync(src, { syntax: "typescript", tsx: f.endsWith("x") });
  const visit = (n, parentKey) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { n.forEach((x) => visit(x, parentKey)); return; }
    switch (n.type) {
      case "ImportDeclaration": case "ExportAllDeclaration": case "TsTypeAnnotation": case "TsInterfaceDeclaration": case "TsTypeAliasDeclaration": return;
      case "JSXText": add(n.value); return;
      case "JSXElement": case "JSXFragment": {
        // Text with values inside one element renders as one text node: "How can {0} reach you?".
        const ch = n.children ?? [];
        if (ch.some((x) => x.type === "JSXExpressionContainer") && ch.some((x) => x.type === "JSXText" && /[A-Za-z]{2}/.test(x.value)) && ch.every((x) => x.type === "JSXText" || x.type === "JSXExpressionContainer")) {
          let i = 0; add(ch.map((x) => (x.type === "JSXText" ? x.value : `{${i++}}`)).join(""));
        }
        break;
      }
      case "StringLiteral": if (parentKey !== "key") fromHtml(n.value); return;
      case "TemplateLiteral": {
        const q = n.quasis.map((x) => x.cooked ?? x.raw);
        const s = q.map((t, i) => (i ? `{${i - 1}}` : "") + t).join("");
        if (s.includes("<")) fromHtml(s); else add(s);
        for (const t of q) fromHtml(t);
        break;
      }
    }
    for (const [k, v] of Object.entries(n)) if (k !== "span" && v && typeof v === "object") visit(v, k);
  };
  visit(ast.body);
}
process.stdout.write(JSON.stringify([...keys].sort(), null, 1) + "\n");
