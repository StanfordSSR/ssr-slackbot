import { PendingReceiptPayload, ReceiptExtraction } from "@/types/receipt";

export function toDataUrl(bytes: ArrayBuffer, mimeType: string) {
  const base64 = Buffer.from(bytes).toString("base64");
  return `data:${mimeType};base64,${base64}`;
}

export function isSupportedReceiptMimeType(mimeType: string) {
  return ["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(mimeType);
}

export function prettyCurrency(amount: number | null, currency: string | null) {
  if (amount == null) return "Unknown";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
    }).format(amount);
  } catch {
    return `${currency || "USD"} ${amount.toFixed(2)}`;
  }
}

export function compactExtractionForSlack(extraction: ReceiptExtraction): ReceiptExtraction {
  return {
    ...extraction,
    merchant: extraction.merchant?.slice(0, 120) ?? null,
    item_name: extraction.item_name?.slice(0, 120) ?? null,
    notes: extraction.notes?.slice(0, 240) ?? null,
  };
}

export function encodeActionValue(payload: PendingReceiptPayload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeActionValue(value: string): PendingReceiptPayload {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as PendingReceiptPayload;
}

export function isGmailPendingReceiptPayload(payload: PendingReceiptPayload) {
  return payload.source === "gmail";
}
