// NEAR's raw errors (RPC, near-api-js, contract panics) are long and technical. Show the user plain words and keep
// the raw text somewhere for support (a title attribute, a log).

export interface ExplainOptions {
  /** Who pays the gas, as the user knows it. Default "The app's". */
  payer?: string;
  /** Longest raw text shown when nothing matches. Default 140. */
  max?: number;
}

/** A NEAR error in words a non-technical user can act on. Unknown errors come back shortened. */
export function explainNearError(text: string, o: ExplainOptions = {}): string {
  const e = String(text ?? "");
  const payer = o.payer ?? "The app's";
  if (/lacks balance|NotEnoughBalance|LackBalanceForState/i.test(e)) return `${payer} NEAR account needs a top-up. It retries by itself.`;
  if (/timeout|timed out|ETIMEDOUT|fetch failed|ECONN|503|502/i.test(e)) return "NEAR is slow to answer right now.";
  if (/AccessKey|access key|Unauthorized|not allowed|Only the seller/i.test(e)) return "Your key on NEAR didn't sign it.";
  if (/InvalidNonce|nonce/i.test(e)) return "Two transactions crossed; it retries by itself.";
  if (/Exceeded the prepaid gas|GasExceeded|GasLimitExceeded/i.test(e)) return "The transaction ran out of gas.";
  if (/AccountDoesNotExist|does not exist while viewing|account .* does not exist/i.test(e)) return "That NEAR account doesn't exist.";
  return e.slice(0, o.max ?? 140);
}
