/** "  Jane@Example.COM " → "jane@example.com"; null unless it looks like a deliverable address. Deliberately simple:
 *  the real check is the seller's email reaching the buyer. */
export const normEmail = (s: string): string | null => {
  const e = s.trim().toLowerCase();
  return e.length <= 254 && /^[^\s@<>"',;]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(e) ? e : null;
};
