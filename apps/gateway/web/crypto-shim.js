// Browser stand-in for node:crypto, used by wallet libraries (here-wallet nonces, near-js local view execution).
import { Buffer } from "buffer";
export const webcrypto = globalThis.crypto;
export const randomBytes = (n) => Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(n)));
export const randomUUID = () => globalThis.crypto.randomUUID();
export function createHash() { throw new Error("createHash is not available in the browser"); }
export default { webcrypto, randomBytes, randomUUID, createHash };
