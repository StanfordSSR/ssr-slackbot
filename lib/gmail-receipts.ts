import { compactExtractionForSlack, isSupportedReceiptMimeType, toDataUrl } from "@/lib/receipt-utils";
import { buildGoogleConsentUrl, createGmailOAuthState, refreshGoogleAccessToken } from "@/lib/google-oauth";
import {
  fetchGmailMessage,
  getMessageMetadata,
  markGmailMessageRead,
  materializeReceiptAttachment,
  pickReceiptArtifactFromMessage,
  searchUnreadGmailMessageIds,
} from "@/lib/gmail";
import { extractReceiptFromImage } from "@/lib/openai";
import { decryptSecret, encryptSecret } from "@/lib/secrets";
import {
  GmailAccountLink,
  createEmailReceiptIngestion,
  disableGmailAccountLink,
  getActiveGmailAccountLinks,
  getLeadProfilesForTeam,
  getTeamById,
  hasEmailReceiptIngestion,
  markEmailReceiptIngestionFailed,
  markGmailScanCompleted,
  markGmailScanStarted,
  updateEmailReceiptIngestionMessages,
  updateGmailAccountLinkTokens,
  uploadStorageArtifact,
} from "@/lib/supabase";
import { lookupSlackUserIdByEmail, postDirectMessageToUser } from "@/lib/slack";
import { receiptReviewBlocks } from "@/lib/slack-blocks";
import { GmailPendingReceiptPayload } from "@/types/receipt";

export async function buildSlackOAuthLink(params: {
  slackUserId: string;
  profileId: string;
  teamId: string;
  gmailEmail: string;
}) {
  const state = createGmailOAuthState(params);
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!redirectUri) {
    throw new Error("Missing GOOGLE_REDIRECT_URI.");
  }
  const origin = new URL(redirectUri).origin;
  const startUrl = new URL("/api/gmail/oauth/start", origin);
  startUrl.searchParams.set("state", state);
  return startUrl.toString();
}

export async function syncAllGmailLinks() {
  const links = await getActiveGmailAccountLinks();
  const results = [];
  for (const link of links) {
    results.push(await syncGmailLink(link));
  }
  return results;
}

export async function syncGmailLink(link: GmailAccountLink) {
  await markGmailScanStarted(link.id);
  const initialBackfill = !link.initial_backfill_completed_at;
  const days = initialBackfill ? 10 : 3;
  let accessToken = link.access_token;

  try {
    if (!accessToken || isExpired(link.access_token_expires_at)) {
      const refreshed = await refreshGoogleAccessToken(decryptSecret(link.refresh_token_encrypted));
      accessToken = refreshed.access_token;
      await updateGmailAccountLinkTokens({
        linkId: link.id,
        accessToken: accessToken,
        accessTokenExpiresAt: toExpiryIso(refreshed.expires_in),
        refreshTokenEncrypted: refreshed.refresh_token ? encryptSecret(refreshed.refresh_token) : undefined,
      });
    }

    const messageIds = await searchUnreadGmailMessageIds(accessToken, days);
    let processed = 0;

    for (const messageId of messageIds) {
      const alreadyProcessed = await hasEmailReceiptIngestion({ gmailLinkId: link.id, gmailMessageId: messageId });
      if (alreadyProcessed) continue;
      processed += await ingestGmailMessage({ link, accessToken, messageId });
    }

    await markGmailScanCompleted(link.id, initialBackfill);
    return { linkId: link.id, processed, initialBackfill };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("401") || message.includes("403") || message.includes("invalid_grant")) {
      await disableGmailAccountLink(link.id);
    }
    throw error;
  }
}

async function ingestGmailMessage(params: { link: GmailAccountLink; accessToken: string; messageId: string }) {
  const { link, accessToken, messageId } = params;
  const message = await fetchGmailMessage(accessToken, messageId);
  const artifact = pickReceiptArtifactFromMessage(message);
  if (!artifact) {
    return 0;
  }

  const team = await getTeamById(link.team_id);
  if (!team) {
    throw new Error(`Team ${link.team_id} was not found for Gmail link ${link.id}.`);
  }

  let bytes: Buffer;
  let filename: string;
  let mimeType: string;
  let artifactSource: "attachment" | "email_pdf";

  if (artifact.kind === "attachment") {
    const materialized = await materializeReceiptAttachment(accessToken, message.id, artifact.part);
    bytes = materialized.bytes;
    filename = materialized.filename;
    mimeType = materialized.mimeType;
    artifactSource = "attachment";
  } else {
    bytes = artifact.bytes;
    filename = artifact.filename;
    mimeType = artifact.mimeType;
    artifactSource = "email_pdf";
  }

  if (!isSupportedReceiptMimeType(mimeType)) {
    return 0;
  }

  const artifactId = crypto.randomUUID();
  const storagePath = buildGmailStoragePath({
    teamId: link.team_id,
    artifactId,
    filename,
    mimeType,
  });

  await uploadStorageArtifact({
    path: storagePath,
    fileBytes: toArrayBuffer(bytes),
    mimeType,
    filename,
  });

  const extraction = compactExtractionForSlack(
    await extractReceiptFromImage({
      dataUrl: toDataUrl(toArrayBuffer(bytes), mimeType),
      mimeType,
      filename,
    }),
  );

  const metadata = getMessageMetadata(message);
  const ingestion = await createEmailReceiptIngestion({
    gmailLinkId: link.id,
    gmailMessageId: message.id,
    gmailThreadId: message.threadId || null,
    teamId: link.team_id,
    senderEmail: metadata.senderEmail,
    subject: metadata.subject,
    receivedAt: metadata.receivedAt,
    artifactSource,
    artifactFilename: filename,
    artifactMimeType: mimeType,
    artifactStoragePath: storagePath,
    extraction,
  });

  try {
    const leadProfiles = await getLeadProfilesForTeam(link.team_id);
    const recipients = await Promise.all(
      leadProfiles
        .filter((lead) => lead.email)
        .map(async (lead) => ({
          lead,
          slackUserId: await lookupSlackUserIdByEmail(lead.email!),
        })),
    );

    if (recipients.length === 0) {
      throw new Error(`No Slack lead recipients found for team ${link.team_id}.`);
    }

    const refs: Array<{ slack_user_id: string; channel: string; ts: string }> = [];
    const payload: GmailPendingReceiptPayload = {
      source: "gmail",
      ingestionId: ingestion.id,
      teamId: team.id,
      teamName: team.name,
      filename,
      mimeType,
      artifactSource,
      senderEmail: metadata.senderEmail,
      subject: metadata.subject,
      extraction,
    };

    for (const recipient of recipients) {
      const result = (await postDirectMessageToUser(
        recipient.slackUserId,
        `I found a draft receipt from ${metadata.senderEmail || "an email"} for *${team.name}*.`,
        receiptReviewBlocks({ teamName: team.name, payload }),
      )) as { channel?: string; ts?: string };

      refs.push({
        slack_user_id: recipient.slackUserId,
        channel: result.channel || recipient.slackUserId,
        ts: result.ts || "",
      });
    }

    await updateEmailReceiptIngestionMessages(ingestion.id, refs);
    await markGmailMessageRead(accessToken, message.id);
    return 1;
  } catch (error) {
    await markEmailReceiptIngestionFailed(ingestion.id, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

function buildGmailStoragePath(params: { teamId: string; artifactId: string; filename: string; mimeType: string }) {
  const prefix = process.env.SUPABASE_RECEIPT_PATH_PREFIX || "slack-bot";
  const extension = inferExtension(params.filename, params.mimeType);
  const baseName = params.filename.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "");
  return `${prefix}/gmail/${params.teamId}/${params.artifactId}-${baseName || "receipt"}.${extension}`;
}

function inferExtension(filename: string, mimeType: string) {
  const clean = filename.toLowerCase();
  if (clean.endsWith(".pdf")) return "pdf";
  if (clean.endsWith(".png")) return "png";
  if (clean.endsWith(".webp")) return "webp";
  if (clean.endsWith(".jpg") || clean.endsWith(".jpeg")) return "jpg";
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  return "jpg";
}

function isExpired(expiresAt: string | null) {
  if (!expiresAt) return true;
  return new Date(expiresAt).getTime() - Date.now() < 60_000;
}

function toExpiryIso(expiresInSeconds: number) {
  return new Date(Date.now() + expiresInSeconds * 1000).toISOString();
}

function toArrayBuffer(buffer: Buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

export { buildGoogleConsentUrl };
