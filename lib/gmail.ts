import { htmlToPlainText } from "@/lib/email-pdf";

type GmailMessagePartBody = {
  attachmentId?: string;
  data?: string;
  size?: number;
};

type GmailMessagePart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: GmailMessagePartBody;
  parts?: GmailMessagePart[];
};

export type GmailAttachmentOption = {
  partId: string;
  filename: string;
  mimeType: string;
};

export type GmailMessage = {
  id: string;
  threadId: string;
  labelIds?: string[];
  payload?: GmailMessagePart;
  internalDate?: string;
  snippet?: string;
};

async function gmailFetch<T>(accessToken: string, path: string, init?: RequestInit) {
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const details = await response.text();
    const snippet = details.slice(0, 300);
    throw new Error(`Gmail API request failed ${response.status} for ${path}${snippet ? `: ${snippet}` : ""}`);
  }

  return (await response.json()) as T;
}

export async function searchGmailMessageIds(accessToken: string, query: string, maxResults = 100) {
  const response = await gmailFetch<{ messages?: Array<{ id: string }> }>(
    accessToken,
    `/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${encodeURIComponent(String(maxResults))}`,
  );
  return (response.messages ?? []).map((message) => message.id);
}

export async function searchUnreadGmailMessageIds(accessToken: string, days: number) {
  const query = `is:unread has:attachment newer_than:${days}d`;
  return searchGmailMessageIds(accessToken, query, 100);
}

export async function fetchGmailMessage(accessToken: string, messageId: string) {
  return gmailFetch<GmailMessage>(accessToken, `/users/me/messages/${messageId}?format=full`);
}

export async function fetchGmailAttachment(accessToken: string, messageId: string, attachmentId: string) {
  const response = await gmailFetch<{ data?: string }>(
    accessToken,
    `/users/me/messages/${messageId}/attachments/${attachmentId}`,
  );

  if (!response.data) {
    throw new Error(`Gmail attachment ${attachmentId} had no data.`);
  }

  return Buffer.from(response.data, "base64url");
}

export async function markGmailMessageRead(accessToken: string, messageId: string) {
  return gmailFetch(
    accessToken,
    `/users/me/messages/${messageId}/modify`,
    {
      method: "POST",
      body: JSON.stringify({ removeLabelIds: ["UNREAD"] }),
    },
  );
}

export function pickReceiptArtifactFromMessage(message: GmailMessage) {
  const attachments = listSupportedReceiptAttachments(message);
  if (attachments.length > 0) {
    return {
      kind: "attachment" as const,
      part: findSupportedReceiptAttachmentPart(message, attachments[0].partId),
    };
  }
  return null;
}

export function listSupportedReceiptAttachments(message: GmailMessage): GmailAttachmentOption[] {
  return flattenMessageParts(message.payload)
    .filter((part) => isSupportedReceiptPart(part) && part.partId)
    .map((part) => ({
      partId: part.partId!,
      filename: part.filename!,
      mimeType: part.mimeType || inferMimeTypeFromFilename(part.filename || "receipt"),
    }));
}

export function findSupportedReceiptAttachmentPart(message: GmailMessage, partId: string) {
  return flattenMessageParts(message.payload).find((part) => part.partId === partId && isSupportedReceiptPart(part)) || null;
}

export function getMessageMetadata(message: GmailMessage) {
  const headers = getHeaderMap(message.payload?.headers);
  const senderEmail = extractEmailAddress(headers.From || null);
  return {
    senderEmail,
    subject: headers.Subject || null,
    receivedAt: message.internalDate ? new Date(Number(message.internalDate)).toISOString() : null,
  };
}

export function getMessageBodyText(message: GmailMessage) {
  const { html, text } = extractMessageBody(message.payload);
  return (html ? htmlToPlainText(html) : text || message.snippet || "").trim();
}

function flattenMessageParts(part?: GmailMessagePart): GmailMessagePart[] {
  if (!part) return [];
  return [part, ...(part.parts ?? []).flatMap((child) => flattenMessageParts(child))];
}

function extractMessageBody(part?: GmailMessagePart): { html: string | null; text: string | null } {
  if (!part) return { html: null, text: null };

  let html: string | null = null;
  let text: string | null = null;

  const visit = (node: GmailMessagePart) => {
    if (node.mimeType === "text/html" && node.body?.data && !html) {
      html = Buffer.from(node.body.data, "base64url").toString("utf8");
    }
    if (node.mimeType === "text/plain" && node.body?.data && !text) {
      text = Buffer.from(node.body.data, "base64url").toString("utf8");
    }
    for (const child of node.parts ?? []) visit(child);
  };

  visit(part);
  return { html, text };
}

function isSupportedReceiptPart(part: GmailMessagePart) {
  const mimeType = part.mimeType || "";
  const filename = (part.filename || "").toLowerCase();
  if (!part.filename || !part.body) return false;
  if (["application/pdf", "image/png", "image/jpeg", "image/webp"].includes(mimeType)) return true;
  return [".pdf", ".png", ".jpg", ".jpeg", ".webp"].some((ext) => filename.endsWith(ext));
}

export async function materializeReceiptAttachment(accessToken: string, messageId: string, part: GmailMessagePart) {
  const filename = part.filename || "receipt";
  const mimeType = part.mimeType || inferMimeTypeFromFilename(filename);
  const body = part.body;
  if (!body) {
    throw new Error("Gmail attachment part was missing a body.");
  }

  if (body.data) {
    return {
      bytes: Buffer.from(body.data, "base64url"),
      filename,
      mimeType,
    };
  }

  if (!body.attachmentId) {
    throw new Error("Gmail attachment part was missing attachmentId.");
  }

  return {
    bytes: await fetchGmailAttachment(accessToken, messageId, body.attachmentId),
    filename,
    mimeType,
  };
}

function inferMimeTypeFromFilename(filename: string) {
  const clean = filename.toLowerCase();
  if (clean.endsWith(".pdf")) return "application/pdf";
  if (clean.endsWith(".png")) return "image/png";
  if (clean.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

function getHeaderMap(headers?: Array<{ name?: string; value?: string }>) {
  return Object.fromEntries((headers ?? []).flatMap((header) => (header.name ? [[header.name, header.value || ""]] : []))) as Record<
    string,
    string
  >;
}

function extractEmailAddress(fromHeader: string | null) {
  if (!fromHeader) return null;
  const match = fromHeader.match(/<([^>]+)>/);
  return (match?.[1] || fromHeader).trim().toLowerCase();
}
