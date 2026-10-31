import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * AES-256-GCM sealing for secrets at rest (seller agent keys, bot tokens). The key comes from the gateway's
 * secret (`NEARCHANT_SECRET_KEY`, compose/Phala secret), never from the repo. Format: v1.<iv>.<tag>.<ciphertext>
 * (base64url). `aad` binds a sealed value to where it belongs (e.g. "alice/orders-key").
 */
export class Sealer {
  private readonly key: Buffer;
  constructor(secret: string) {
    if (!secret || secret.length < 32) throw new Error("NEARCHANT_SECRET_KEY must be at least 32 characters");
    this.key = createHash("sha256").update(secret).digest();
  }
  seal(plain: string, aad: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
  }
  open(sealed: string, aad: string): string {
    const [v, iv, tag, ct] = sealed.split(".");
    if (v !== "v1" || !iv || !tag || !ct) throw new Error("bad sealed value");
    const d = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
  }
}
