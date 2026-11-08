// Proves each kit works when copied alone: copies the kit folder into an empty temp dir (outside this repo, so no
// workspace packages or hoisted node_modules can help), installs only its package.json, then typechecks and tests it.
// Also fails on imports that leave the kit folder.   node kits/scripts/check-copy.mjs [kit-path …]
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, dirname } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const all = ["market", "content"].flatMap((g) => existsSync(join(root, g)) ? readdirSync(join(root, g)).map((k) => join(root, g, k)) : [])
  .filter((d) => existsSync(join(d, "package.json")));
const kits = process.argv.length > 2 ? process.argv.slice(2).map((p) => resolve(p)) : all;
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return f === "node_modules" || f === "target" ? [] : statSync(p).isDirectory() ? walk(p) : [p]; });
const results = [];
for (const kit of kits) {
  const name = relative(root, kit), problems = [];
  // 1. imports stay inside the kit
  for (const f of walk(kit).filter((f) => /\.(ts|mts|js|mjs)$/.test(f))) {
    for (const m of readFileSync(f, "utf8").matchAll(/(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g)) {
      const spec = m[1];
      if (spec.startsWith("@nearchant/")) problems.push(`${relative(kit, f)} imports ${spec}`);
      if (spec.startsWith(".") && !resolve(dirname(f), spec).startsWith(kit)) problems.push(`${relative(kit, f)} imports outside the kit: ${spec}`);
    }
  }
  // 2. copy alone, install, typecheck, test
  const tmp = mkdtempSync(join(tmpdir(), "kit-"));
  const step = (label, cmd) => { try { execSync(cmd, { cwd: tmp, stdio: "pipe", timeout: 600_000 }); return true; } catch (e) { problems.push(`${label} failed:\n${String(e.stdout ?? "")}${String(e.stderr ?? "")}`.slice(0, 2500)); return false; } };
  cpSync(kit, tmp, { recursive: true, filter: (s) => !/node_modules|\/target(\/|$)/.test(s) });
  if (step("npm install", "npm install --no-audit --no-fund --loglevel=error")) {
    step("typecheck", "npx --no-install tsc -p tsconfig.json --noEmit");
    step("tests", "npx --no-install vitest run --passWithNoTests");
  }
  rmSync(tmp, { recursive: true, force: true });
  results.push({ kit: name, ok: !problems.length, problems });
  console.log(`${problems.length ? "✗" : "✓"} ${name}${problems.length ? `\n  ${problems.join("\n  ")}` : ""}`);
}
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} kits work when copied alone`);
process.exit(bad.length ? 1 : 0);
