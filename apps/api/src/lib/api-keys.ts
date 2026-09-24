import { randomBytes, randomUUID } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";

// Format: cn_<key id, 32 hex>_<secret, 43 base64url>. The id lets us look up a
// single row and argon2-verify it, instead of hashing against every key.
const KEY_RE = /^cn_([0-9a-f]{32})_([A-Za-z0-9_-]{43})$/;

export interface GeneratedKey {
  id: string;
  plaintext: string;
  hash: string;
}

export async function generateApiKey(): Promise<GeneratedKey> {
  const id = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  return { id, plaintext: `cn_${id.replace(/-/g, "")}_${secret}`, hash: await hash(secret) };
}

export function parseApiKey(plaintext: string): { id: string; secret: string } | null {
  const m = KEY_RE.exec(plaintext);
  if (!m) return null;
  const h = m[1]!;
  return { id: `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`, secret: m[2]! };
}

export const verifyApiKey = (storedHash: string, secret: string) => verify(storedHash, secret).catch(() => false);

export function bearerToken(header: string | undefined): string | null {
  const m = header && /^Bearer\s+(\S+)$/i.exec(header);
  return m ? m[1]! : null;
}
