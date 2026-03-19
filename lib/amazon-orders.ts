import { extractAmazonOrderFromEmail } from "@/lib/openai";
import { buildGoogleConsentUrl, createAmazonOAuthState, refreshGoogleAccessToken } from "@/lib/google-oauth";
import { decryptSecret, encryptSecret } from "@/lib/secrets";
import {
  AmazonAccountLink,
  createAmazonOrderIngestion,
  disableAmazonAccountLink,
  getActiveAmazonAccountLink,
  getActiveTeams,
  getAmazonOrderIngestionByMessage,
  markAmazonOrderIngestionFailed,
  markAmazonOrderIngestionPosted,
  markAmazonScanCompleted,
  markAmazonScanStarted,
  updateAmazonAccountLinkTokens,
} from "@/lib/supabase";
import { fetchGmailMessage, getMessageBodyText, getMessageMetadata, markGmailMessageRead, searchGmailMessageIds } from "@/lib/gmail";
import { amazonClaimBlocks } from "@/lib/slack-blocks";
import { postMessage } from "@/lib/slack";

export async function buildAmazonOAuthLink(params: {
  slackUserId: string;
  profileId: string;
  gmailEmail: string;
  channelId: string;
}) {
  const state = createAmazonOAuthState({
    kind: "amazon",
    slackUserId: params.slackUserId,
    profileId: params.profileId,
    gmailEmail: params.gmailEmail,
    channelId: params.channelId,
  });
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!redirectUri) {
    throw new Error("Missing GOOGLE_REDIRECT_URI.");
  }
  const origin = new URL(redirectUri).origin;
  const startUrl = new URL("/api/gmail/oauth/start", origin);
  startUrl.searchParams.set("state", state);
  return startUrl.toString();
}

export async function getAuthorizedAmazonAccessToken(link: AmazonAccountLink) {
  let accessToken = link.access_token;

  if (!accessToken || isExpired(link.access_token_expires_at)) {
    const refreshed = await refreshGoogleAccessToken(decryptSecret(link.refresh_token_encrypted));
    accessToken = refreshed.access_token;
    await updateAmazonAccountLinkTokens({
      linkId: link.id,
      accessToken,
      accessTokenExpiresAt: toExpiryIso(refreshed.expires_in),
      refreshTokenEncrypted: refreshed.refresh_token ? encryptSecret(refreshed.refresh_token) : undefined,
    });
  }

  return accessToken;
}

export async function syncAmazonAccountLink(link: AmazonAccountLink) {
  return syncAmazonAccountLinkForDays(link);
}

export async function syncAmazonAccountLinkForDays(link: AmazonAccountLink, days = 1) {
  await markAmazonScanStarted(link.id);

  try {
    const accessToken = await getAuthorizedAmazonAccessToken(link);
    const messageIds = await searchGmailMessageIds(
      accessToken,
      `is:unread newer_than:${days}d from:amazon.com subject:ordered -subject:shipped -subject:delivered`,
      100,
    );
    let posted = 0;

    for (const messageId of messageIds) {
      const existing = await getAmazonOrderIngestionByMessage({ amazonLinkId: link.id, gmailMessageId: messageId });
      if (existing) continue;
      posted += await ingestAmazonOrderMessage({ link, accessToken, messageId });
    }

    await markAmazonScanCompleted(link.id);
    return { linkId: link.id, unreadCount: messageIds.length, posted };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("401") || message.includes("403") || message.includes("invalid_grant")) {
      await disableAmazonAccountLink(link.id);
    }
    throw error;
  }
}

export async function syncActiveAmazonAccount() {
  const link = await getActiveAmazonAccountLink();
  if (!link) {
    return { linkId: null, unreadCount: 0, posted: 0 };
  }
  return syncAmazonAccountLinkForDays(link);
}

export async function syncActiveAmazonAccountForDays(days: number) {
  const link = await getActiveAmazonAccountLink();
  if (!link) {
    return { linkId: null, unreadCount: 0, posted: 0 };
  }
  return syncAmazonAccountLinkForDays(link, days);
}

async function ingestAmazonOrderMessage(params: { link: AmazonAccountLink; accessToken: string; messageId: string }) {
  const { link, accessToken, messageId } = params;
  const message = await fetchGmailMessage(accessToken, messageId);
  const metadata = getMessageMetadata(message);

  if (!metadata.senderEmail || !metadata.senderEmail.endsWith("amazon.com")) {
    return 0;
  }

  const subject = metadata.subject || "";
  if (!/\bordered\b/i.test(subject) || /\b(shipped|delivered)\b/i.test(subject)) {
    return 0;
  }
  const bodyText = getMessageBodyText(message);
  const combinedText = `${subject}\n${bodyText}`;

  const extraction = await extractAmazonOrderFromEmail({
    subject: metadata.subject,
    senderEmail: metadata.senderEmail,
    receivedAt: metadata.receivedAt,
    bodyText: combinedText,
  });

  const ingestion = await createAmazonOrderIngestion({
    amazonLinkId: link.id,
    gmailMessageId: message.id,
    gmailThreadId: message.threadId || null,
    senderEmail: metadata.senderEmail,
    subject: metadata.subject,
    receivedAt: metadata.receivedAt,
    extraction,
  });

  try {
    if (!extraction.item_name || extraction.amount_total == null) {
      await markAmazonOrderIngestionFailed(ingestion.id, "Could not extract an Amazon item name and grand total from the email.");
      return 0;
    }

    const teams = await getActiveTeams();
    if (teams.length === 0) {
      await markAmazonOrderIngestionFailed(ingestion.id, "No active teams were available for claiming.");
      return 0;
    }

    const result = await postMessage(
      link.slack_channel_id,
      `Amazon purchase: ${extraction.item_name} - ${formatAmount(extraction.amount_total, extraction.currency)}`,
      amazonClaimBlocks({
        ingestionId: ingestion.id,
        itemName: extraction.item_name,
        amountTotal: extraction.amount_total,
        currency: extraction.currency,
        purchaseDate: extraction.purchase_date || metadata.receivedAt?.slice(0, 10) || null,
        teams,
      }),
    );

    await markAmazonOrderIngestionPosted({
      ingestionId: ingestion.id,
      slackChannelId: result.channel,
      slackMessageTs: result.ts,
    });
    await markGmailMessageRead(accessToken, message.id);
    return 1;
  } catch (error) {
    await markAmazonOrderIngestionFailed(ingestion.id, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

function formatAmount(amount: number, currency: string | null) {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
    }).format(amount);
  } catch {
    return `${currency || "USD"} ${amount.toFixed(2)}`;
  }
}

function isExpired(expiresAt: string | null) {
  if (!expiresAt) return true;
  return new Date(expiresAt).getTime() - Date.now() < 60_000;
}

function toExpiryIso(expiresInSeconds: number) {
  return new Date(Date.now() + expiresInSeconds * 1000).toISOString();
}

export { buildGoogleConsentUrl };
