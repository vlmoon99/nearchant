import { createHash } from "node:crypto";
import type { KeyPair } from "near-api-js";
import { nep413Payload } from "../src/nep413.js";

/** What a NEAR wallet does for NEP-413: sha256 of the payload, ed25519-signed, base64. */
export function walletSign(kp: KeyPair, p: Parameters<typeof nep413Payload>[0]): string {
  return Buffer.from(kp.sign(createHash("sha256").update(nep413Payload(p)).digest()).signature).toString("base64");
}
