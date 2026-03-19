const required = [
  "SLACK_BOT_TOKEN",
  "SLACK_SIGNING_SECRET",
  "OPENAI_API_KEY",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

type RequiredEnv = (typeof required)[number];
type OptionalEnv =
  | "OPENAI_CHAT_MODEL"
  | "OPENAI_RECEIPT_MODEL"
  | "SUPABASE_RECEIPT_BUCKET"
  | "SUPABASE_RECEIPT_PATH_PREFIX";

export function getEnv(name: RequiredEnv | OptionalEnv) {
  const value = process.env[name];
  if (!value && required.includes(name as RequiredEnv)) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function getReceiptModel() {
  return process.env.OPENAI_RECEIPT_MODEL || "gpt-4.1-mini";
}

export function getChatModel() {
  return process.env.OPENAI_CHAT_MODEL || "gpt-5-mini";
}
