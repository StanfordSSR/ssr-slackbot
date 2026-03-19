import { after, NextResponse } from "next/server";
import { verifySlackSignature } from "@/lib/slack-signature";
import { getEnv } from "@/lib/env";
import {
  downloadSlackFile,
  fetchConversationHistory,
  fetchFileInfo,
  getSlackUserIdentity,
  postDm,
  postMessage,
} from "@/lib/slack";
import { isSupportedReceiptMimeType, toDataUrl, compactExtractionForSlack } from "@/lib/receipt-utils";
import { answerSlackMention, extractReceiptFromImage } from "@/lib/openai";
import { receiptReviewBlocks, teamChoiceBlocks } from "@/lib/slack-blocks";
import { findProfileByEmail, getLeadTeamsForUser } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SlackEventEnvelope = {
  type: string;
  challenge?: string;
  event?: {
    type: string;
    subtype?: string;
    user?: string;
    channel?: string;
    channel_type?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
    bot_id?: string;
    files?: Array<{ id: string; mimetype?: string; name?: string }>;
  };
};

function getSlackEventMode(event: NonNullable<SlackEventEnvelope["event"]>) {
  if (event.bot_id) return false;
  if (event.type === "app_mention") return "channel_mention" as const;
  if (event.type !== "message") return false;
  if (event.channel_type !== "im") return false;
  if (!event.subtype || event.subtype === "file_share") return "dm_receipt" as const;
  return false;
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  const signingSecret = getEnv("SLACK_SIGNING_SECRET")!;
  const isValid = await verifySlackSignature(request, rawBody, signingSecret);

  if (!isValid) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  const body = JSON.parse(rawBody) as SlackEventEnvelope;

  if (body.type === "url_verification") {
    return NextResponse.json({ challenge: body.challenge });
  }

  if (body.type !== "event_callback" || !body.event) {
    return NextResponse.json({ ok: true });
  }

  const event = body.event;
  const mode = getSlackEventMode(event);
  console.info("Slack event received", {
    eventType: event.type,
    subtype: event.subtype ?? null,
    channelType: event.channel_type ?? null,
    hasFiles: Boolean(event.files?.length),
    fileCount: event.files?.length ?? 0,
    mode,
  });

  if (!mode) {
    return NextResponse.json({ ok: true });
  }

  after(async () => {
    try {
      if (mode === "dm_receipt") {
        await handleMessageEvent(event);
        return;
      }

      await handleChannelMention(event);
    } catch (error) {
      console.error("Failed to handle Slack event", error);
      if (event.channel) {
        const fallback =
          mode === "dm_receipt"
            ? "I hit a snag while reading that receipt. Try again with a clearer image or PDF."
            : "My circuits got a little tangled on that one. Please try again in a sec.";
        await postMessage(event.channel, fallback);
      }
    }
  });

  return NextResponse.json({ ok: true });
}

async function handleMessageEvent(event: NonNullable<SlackEventEnvelope["event"]>) {
  const userId = event.user;
  const channel = event.channel;
  const file = event.files?.[0];

  if (!userId || !channel) return;

  console.info("Handling Slack DM receipt event", {
    userId,
    channel,
    subtype: event.subtype ?? null,
    fileId: file?.id ?? null,
    filename: file?.name ?? null,
    mimeType: file?.mimetype ?? null,
  });

  if (!file?.id) {
    await postDm(channel, "Send me a receipt image or PDF and I’ll try to log it to your team.");
    return;
  }

  console.info("Resolving Slack user identity and HQ profile", { userId, channel });
  const identity = await getSlackUserIdentity(userId);
  const profile = await findProfileByEmail(identity.email);

  if (!profile) {
    await postDm(
      channel,
      `I couldn't match your Slack email (${identity.email}) to an SSR HQ profile. Add that email to public.profiles.email first.`,
    );
    return;
  }

  const teams = await getLeadTeamsForUser(profile.id);
  if (teams.length === 0) {
    await postDm(channel, "You aren't authorized to submit receipts for any active team lead role.");
    return;
  }

  const fileInfo = await fetchFileInfo(file.id);
  const slackFile = fileInfo.file as {
    id: string;
    mimetype?: string;
    name?: string;
    url_private_download?: string;
  };

  const mimeType = slackFile.mimetype || file.mimetype || "application/octet-stream";
  if (!isSupportedReceiptMimeType(mimeType)) {
    await postDm(channel, "I can currently read JPEG, PNG, WEBP, and PDF receipts.");
    return;
  }

  if (!slackFile.url_private_download) {
    await postDm(channel, "Slack did not provide a downloadable file URL for that upload.");
    return;
  }

  await postDm(channel, "Reading your receipt...");

  const fileBytes = await downloadSlackFile(slackFile.url_private_download);
  const extraction = compactExtractionForSlack(
    await extractReceiptFromImage({
      dataUrl: toDataUrl(fileBytes.arrayBuffer, mimeType),
      mimeType,
      filename: slackFile.name || file.name || "receipt",
    }),
  );

  const filename = slackFile.name || file.name || "receipt";

  if (teams.length === 1) {
    const payload = {
      source: "slack" as const,
      teamId: teams[0].id,
      teamName: teams[0].name,
      fileId: slackFile.id,
      filename,
      mimeType,
      extraction,
    };

    await postDm(
      channel,
      `Here’s the draft I extracted for *${teams[0].name}*.`,
      receiptReviewBlocks({ teamName: teams[0].name, payload }),
    );
    return;
  }

  await postDm(
    channel,
    "I found multiple teams you lead.",
    teamChoiceBlocks({ teams, extraction, fileId: slackFile.id, filename, mimeType }),
  );
}

async function handleChannelMention(event: NonNullable<SlackEventEnvelope["event"]>) {
  const channel = event.channel;

  if (!channel) return;

  const prompt = cleanMentionText(event.text);
  if (!prompt) {
    await postMessage(channel, "Hai! Ask me anything about SSR HQ, receipts, or robotics and I’ll do my sparkly best to help.");
    return;
  }

  console.info("Handling Slack channel mention", {
    channel,
    ts: event.thread_ts || event.ts,
    promptPreview: prompt.slice(0, 160),
  });

  let context: Array<{ speaker: string; text: string }> = [];
  try {
    const history = await fetchConversationHistory(channel, 15);
    context = (history.messages ?? [])
      .filter((message) => !message.subtype)
      .reverse()
      .map((message) => ({
        speaker: message.user ? `<@${message.user}>` : message.bot_id ? "bot" : "unknown",
        text: cleanMentionText(message.text).slice(0, 500),
      }))
      .filter((message) => message.text);

    console.info("Loaded Slack mention context", {
      channel,
      messageCount: context.length,
    });
  } catch (error) {
    console.warn("Could not load Slack channel history for mention context", {
      channel,
      error,
    });
  }

  console.info("Generating Slack mention reply", {
    channel,
    hasContext: context.length > 0,
  });
  const reply = await answerSlackMention({ prompt, history: context });
  await postMessage(channel, reply);
}

function cleanMentionText(text?: string) {
  return (text || "")
    .replace(/<@[A-Z0-9]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
