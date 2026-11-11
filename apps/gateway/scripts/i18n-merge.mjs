// Merges the translated parts (i18n/parts/tr-*.json: { english: { ru, uk } }) into i18n/ru.json and i18n/uk.json.
//   node scripts/i18n-merge.mjs
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = new URL("../i18n", import.meta.url).pathname;
const out = { ru: {}, uk: {} };
for (const f of readdirSync(join(dir, "parts")).filter((f) => /^tr-.*\.json$/.test(f)).sort()) {
  for (const [k, v] of Object.entries(JSON.parse(readFileSync(join(dir, "parts", f), "utf8")))) {
    for (const l of ["ru", "uk"]) if (typeof v?.[l] === "string" && v[l].trim()) out[l][k] = v[l];
  }
}
for (const [k, v] of Object.entries(JSON.parse(readFileSync(join(dir, "overrides.json"), "utf8")))) {
  if (k.startsWith("_")) continue;
  for (const l of ["ru", "uk"]) { if (v === null) delete out[l][k]; else if (v[l]) out[l][k] = v[l]; }
}
for (const l of ["ru", "uk"]) {
  const sorted = Object.fromEntries(Object.entries(out[l]).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(join(dir, `${l}.json`), JSON.stringify(sorted, null, 1) + "\n");
  console.log(`${l}: ${Object.keys(sorted).length} strings`);
}
