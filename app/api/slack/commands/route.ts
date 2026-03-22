import { NextResponse } from "next/server";
import { parse } from "node:querystring";
import { verifySlackSignature } from "@/lib/slack-signature";
import { getEnv } from "@/lib/env";
import { after } from "next/server";
import { buildAmazonOAuthLink, syncActiveAmazonAccountForDays } from "@/lib/amazon-orders";
import { buildSlackOAuthLink, syncGmailLinkForDays } from "@/lib/gmail-receipts";
import { gmailLinkTeamChoiceBlocks } from "@/lib/slack-blocks";
import { getSlackUserIdentity, lookupSlackUserIdByEmail, postDelayedSlackResponse, postSlackResponse } from "@/lib/slack";
import {
  findProfileByEmail,
  getActiveAmazonAccountLink,
  getActiveGmailAccountLinksForProfile,
  getLeadTeamsForUser,
  getProfilesForSlackSync,
  getTeamById,
  updateProfileSlackUserId,
} from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rawBody = await request.text();
  const signingSecret = getEnv("SLACK_SIGNING_SECRET")!;
  const isValid = await verifySlackSignature(request, rawBody, signingSecret);

  if (!isValid) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  const body = parse(rawBody);
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const slackUserId = typeof body.user_id === "string" ? body.user_id : "";
  const command = typeof body.command === "string" ? body.command : "";
  const responseUrl = typeof body.response_url === "string" ? body.response_url : "";

  if (command === "/scanemail") {
    return handleScanEmailCommand({ text, slackUserId, responseUrl });
  }

  if (command === "/amazonsync") {
    return handleAmazonSyncCommand({ text, slackUserId, responseUrl });
  }

  if (command === "/amazonlink") {
    return handleAmazonLinkCommand({ text, slackUserId });
  }

  if (command === "/slackusersync") {
    return handleSlackUserSyncCommand({ slackUserId, responseUrl });
  }

  if (command && command !== "/link") {
    return NextResponse.json({
      response_type: "ephemeral",
      text: "This endpoint is for `/link`, `/scanemail`, `/amazonlink`, `/amazonsync`, and `/slackusersync`.",
    });
  }

  const gmailEmail = normalizeGmailAddress(text);
  if (!gmailEmail) {
    return NextResponse.json({
      response_type: "ephemeral",
      text: "Usage: `/link your-mailbox@gmail.com`",
    });
  }

  const identity = await getSlackUserIdentity(slackUserId);
  const profile = await findProfileByEmail(identity.email);
  if (!profile) {
    return NextResponse.json({
      response_type: "ephemeral",
      text: `I couldn't match your Slack email (${identity.email}) to an SSR HQ profile.`,
    });
  }

  const teams = await getLeadTeamsForUser(profile.id);
  if (teams.length === 0) {
    return NextResponse.json({
      response_type: "ephemeral",
      text: "You aren't authorized to link Gmail for any active team lead role.",
    });
  }

  if (teams.length > 1) {
    return NextResponse.json({
      response_type: "ephemeral",
      text: "Choose which team should use this Gmail account.",
      blocks: gmailLinkTeamChoiceBlocks({ teams, gmailEmail }),
    });
  }

  const oauthUrl = await buildSlackOAuthLink({
    slackUserId,
    profileId: profile.id,
    teamId: teams[0].id,
    gmailEmail,
  });

  return NextResponse.json({
    response_type: "ephemeral",
    text: `Connect ${gmailEmail} for ${teams[0].name}.`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `Link *${gmailEmail}* to *${teams[0].name}* for Gmail receipt intake.`,
        },
        accessory: {
          type: "button",
          text: { type: "plain_text", text: "Connect Gmail" },
          url: oauthUrl,
          action_id: "open_gmail_oauth",
        },
      },
    ],
  });
}

function normalizeGmailAddress(input: string) {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
  return isEmail ? trimmed : null;
}

function parseScanDays(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return 3;
  if (!/^\d+$/.test(trimmed)) return null;
  const days = Number(trimmed);
  if (!Number.isInteger(days) || days < 1 || days > 30) return null;
  return days;
}

async function handleScanEmailCommand(params: { text: string; slackUserId: string; responseUrl: string }) {
  const days = parseScanDays(params.text);
  if (days == null) {
    return NextResponse.json({
      response_type: "ephemeral",
      text: "Usage: `/scanemail <days>` where days is a number from 1 to 30.",
    });
  }

  const identity = await getSlackUserIdentity(params.slackUserId);
  const profile = await findProfileByEmail(identity.email);
  if (!profile) {
    return NextResponse.json({
      response_type: "ephemeral",
      text: `I couldn't match your Slack email (${identity.email}) to an SSR HQ profile.`,
    });
  }

  const links = await getActiveGmailAccountLinksForProfile(profile.id);
  if (links.length === 0) {
    return NextResponse.json({
      response_type: "ephemeral",
      text: "You don't have any active Gmail links yet. Run `/link your-mailbox@gmail.com` first.",
    });
  }

  after(async () => {
    try {
      await Promise.all(
        links.map(async (link) => {
          await getTeamById(link.team_id);
          await syncGmailLinkForDays(link, days);
        }),
      );

      await postSlackResponse(params.responseUrl, {
        replace_original: true,
        text: "Gmail scan finished.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await postDelayedSlackResponse(
        params.responseUrl,
        `Email scan failed: ${message}`,
      );
    }
  });

  return NextResponse.json({
    response_type: "ephemeral",
    text: `Starting Gmail scan for the last ${days} day(s). I’ll post the results here when it finishes.`,
  });
}

async function handleAmazonLinkCommand(params: { text: string; slackUserId: string }) {
  const [rawEmail, rawChannelId] = params.text.split(/\s+/).filter(Boolean);
  const gmailEmail = normalizeGmailAddress(rawEmail || "");
  const channelId = (rawChannelId || "").trim();

  if (!gmailEmail || !channelId) {
    return NextResponse.json({
      response_type: "ephemeral",
      text: "Usage: `/amazonlink <email> <channel-id>`",
    });
  }

  const identity = await getSlackUserIdentity(params.slackUserId);
  const profile = await findProfileByEmail(identity.email);
  if (!profile?.is_admin) {
    return NextResponse.json({
      response_type: "ephemeral",
      text: "Only admins can link the Amazon inbox.",
    });
  }

  const oauthUrl = await buildAmazonOAuthLink({
    slackUserId: params.slackUserId,
    profileId: profile.id,
    gmailEmail,
    channelId,
  });

  return NextResponse.json({
    response_type: "ephemeral",
    text: `Connect ${gmailEmail} for Amazon order sync into ${channelId}.`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `Link *${gmailEmail}* to post Amazon claims into *${channelId}*.`,
        },
        accessory: {
          type: "button",
          text: { type: "plain_text", text: "Connect Gmail" },
          url: oauthUrl,
          action_id: "open_amazon_oauth",
        },
      },
    ],
  });
}

async function handleAmazonSyncCommand(params: { text: string; slackUserId: string; responseUrl: string }) {
  const days = parseScanDays(params.text);
  if (days == null) {
    return NextResponse.json({
      response_type: "ephemeral",
      text: "Usage: `/amazonsync <days>` where days is a number from 1 to 30. Leaving it blank defaults to 3.",
    });
  }

  const identity = await getSlackUserIdentity(params.slackUserId);
  const profile = await findProfileByEmail(identity.email);
  if (!profile) {
    return NextResponse.json({
      response_type: "ephemeral",
      text: `I couldn't match your Slack email (${identity.email}) to an SSR HQ profile.`,
    });
  }

  const leadTeams = await getLeadTeamsForUser(profile.id);
  if (!profile.is_admin && leadTeams.length === 0) {
    return NextResponse.json({
      response_type: "ephemeral",
      text: "Only admins or active team leads can run `/amazonsync`.",
    });
  }

  const link = await getActiveAmazonAccountLink();
  if (!link) {
    return NextResponse.json({
      response_type: "ephemeral",
      text: "No Amazon inbox is linked yet. Run `/amazonlink <email> <channel-id>` first.",
    });
  }

  after(async () => {
    try {
      await syncActiveAmazonAccountForDays(days);
      await postSlackResponse(params.responseUrl, {
        replace_original: true,
        text: "Amazon sync finished.",
      });
    } catch (error) {
      await postDelayedSlackResponse(params.responseUrl, `Amazon sync failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  return NextResponse.json({
    response_type: "ephemeral",
    text: `Starting Amazon sync for the last ${days} day(s). I’ll clean this up when it finishes.`,
  });
}

async function handleSlackUserSyncCommand(params: { slackUserId: string; responseUrl: string }) {
  const identity = await getSlackUserIdentity(params.slackUserId);
  const profile = await findProfileByEmail(identity.email);
  if (!profile?.is_admin) {
    return NextResponse.json({
      response_type: "ephemeral",
      text: "Only admins can run `/slackusersync`.",
    });
  }

  after(async () => {
    let matched = 0;
    let failed = 0;
    let alreadyLinked = 0;

    try {
      const profiles = await getProfilesForSlackSync();

      for (const entry of profiles) {
        const email = entry.email?.trim().toLowerCase();
        if (!email) continue;

        if (entry.slack_user_id) {
          alreadyLinked += 1;
          continue;
        }

        try {
          const slackUserId = await lookupSlackUserIdByEmail(email);
          await updateProfileSlackUserId({ profileId: entry.id, slackUserId });
          matched += 1;
        } catch {
          failed += 1;
        }
      }

      await postSlackResponse(params.responseUrl, {
        replace_original: true,
        text: `Slack user sync finished. Added ${matched}, already linked ${alreadyLinked}, failed ${failed}.`,
      });
    } catch (error) {
      await postDelayedSlackResponse(
        params.responseUrl,
        `Slack user sync failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  return NextResponse.json({
    response_type: "ephemeral",
    text: "Starting Slack user sync. I’ll clean this up when it finishes.",
  });
}
