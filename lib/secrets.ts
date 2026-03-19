import { createCipheriv, createDecipheriv, createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getEnv } from "@/lib/env";

function getEncryptionKey() {
  const raw = getEnv("GMAIL_TOKEN_ENCRYPTION_KEY") || getEnv("GOOGLE_CLIENT_SECRET") || getEnv("SLACK_SIGNING_SECRET");
  if (!raw) {
    throw new Error("Missing encryption secret for Gmail token storage.");
  }
  return createHash("sha256").update(raw).digest();
}

export function encryptSecret(plaintext: string) {
  const key = getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64url");
}

export function decryptSecret(ciphertext: string) {
  const raw = Buffer.from(ciphertext, "base64url");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", getEncryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

export function signPayload(payload: string) {
  const secret = getEnv("SLACK_SIGNING_SECRET")!;
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function verifySignedPayload(payload: string, signature: string) {
  const expected = signPayload(payload);
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
