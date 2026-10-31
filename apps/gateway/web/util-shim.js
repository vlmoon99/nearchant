// Browser stand-in for node:util, used only by generate-function (a transitive dep of near-api-js).
export function format(f, ...args) {
  let i = 0;
  const s = String(f).replace(/%[sdj%]/g, (m) => (m === "%%" ? "%" : m === "%j" ? JSON.stringify(args[i++]) : String(args[i++])));
  return [s, ...args.slice(i)].join(" ");
}
export function inspect(v) { return typeof v === "string" ? JSON.stringify(v) : String(v); }
export default { format, inspect };
