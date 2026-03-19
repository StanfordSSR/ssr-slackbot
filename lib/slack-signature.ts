import crypto from "node:crypto";

export async function verifySlackSignature(request: Request, rawBody: string, signingSecret: string) {
  const timestamp = request.headers.get("x-slack-request-timestamp");
  const signature = request.headers.get("x-slack-signature");

  if (!timestamp || !signature) {
    return false;
  }

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (age > 60 * 5) {
    return false;
  }

  const basestring = `v0:${timestamp}:${rawBody}`;
  const digest = `v0=${crypto.createHmac("sha256", signingSecret).update(basestring).digest("hex")}`;

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
  } catch {
    return false;
  }
}
