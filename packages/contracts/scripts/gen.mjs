// Generates src/generated/types.ts and src/generated/schemas.ts from ../../spec/schemas.
// Run on every build; the generated folder is committed so readers can see the types.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "json-schema-to-typescript";

const here = dirname(fileURLToPath(import.meta.url));
const specDir = join(here, "../../../spec/schemas");
const outDir = join(here, "../src/generated");
mkdirSync(outDir, { recursive: true });

const files = readdirSync(specDir).filter((f) => f.endsWith(".schema.json")).sort();
const schemas = Object.fromEntries(files.map((f) => [f, JSON.parse(readFileSync(join(specDir, f), "utf8"))]));

const banner = "// GENERATED from spec/schemas by packages/contracts/scripts/gen.mjs — do not edit.\n";
let types = banner;
const seen = new Set();
for (const f of files) {
  const ts = await compile(schemas[f], schemas[f].title, {
    cwd: specDir,
    bannerComment: "",
    additionalProperties: false,
    declareExternallyReferenced: true,
    unreachableDefinitions: true,
    style: { semi: true, singleQuote: false },
  });
  // Drop declarations already emitted by an earlier file (shared $defs).
  const blocks = ts.split(/\n(?=(?:\/\*\*[\s\S]*?\*\/\n)?export )/);
  for (const b of blocks) {
    const name = b.match(/export (?:type|interface) (\w+)/)?.[1];
    if (!name || seen.has(name)) continue;
    seen.add(name);
    types += "\n" + b.trim() + "\n";
  }
}
writeFileSync(join(outDir, "types.ts"), types);
writeFileSync(
  join(outDir, "schemas.ts"),
  banner + "export const schemas = " + JSON.stringify(schemas, null, 2) + " as const;\n",
);
console.log(`gen: ${files.length} schemas, ${seen.size} types`);
