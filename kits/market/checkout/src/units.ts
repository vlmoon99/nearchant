// Token amounts are integer strings in base units (U128). These helpers convert for display only — never do money
// maths with floats.
import { viewCall, type RpcOptions } from "./rpc.js";

/** "1234500000", 6 → "1,234.5". Truncates (never shows more than there is); `maxFraction` digits, default 2. */
export function formatUnits(amount: bigint | string, decimals: number, maxFraction = 2): string {
  let v = BigInt(amount);
  const neg = v < 0n;
  if (neg) v = -v;
  const base = 10n ** BigInt(decimals);
  const whole = (v / base).toLocaleString("en");
  const frac = decimals > 0 ? (v % base).toString().padStart(decimals, "0").slice(0, maxFraction).replace(/0+$/, "") : "";
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** "1.5", 6 → "1500000". Throws on more decimals than the token has or on anything that isn't a plain number. */
export function parseUnits(text: string, decimals: number): string {
  const m = /^(\d+)(?:\.(\d*))?$/.exec(text.trim().replace(/,/g, ""));
  if (!m) throw new Error(`not an amount: ${text}`);
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new Error(`at most ${decimals} decimals`);
  return (BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0")).toString();
}

/** NEP-141 balance of `accountId` on `token`, read with finality "optimistic"; null when it can't be read. */
export async function tokenBalance(o: RpcOptions & { token: string; accountId: string }): Promise<bigint | null> {
  try {
    const b = await viewCall<string>(o.token, "ft_balance_of", { account_id: o.accountId }, o);
    return /^\d+$/.test(String(b)) ? BigInt(b) : null;
  } catch {
    return null;
  }
}
