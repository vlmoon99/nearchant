/** "12.5" → integer units with `decimals` places, exactly (no floats). */
export function toUnits(amount: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!m || (m[2] ?? "").length > decimals) throw new Error(`amount: a number with at most ${decimals} decimals`);
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt((m[2] ?? "").padEnd(decimals, "0") || "0");
}
