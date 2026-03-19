import { NextResponse } from "next/server";
import { parse } from "node:querystring";
import { verifySlackSignature } from "@/lib/slack-signature";
import { getEnv } from "@/lib/env";
import { after } from "next/server";
import { buildSlackOAuthLink, syncGmailLinkForDays } from "@/lib/gmail-receipts";
import { gmailLinkTeamChoiceBlocks } from "@/lib/slack-blocks";
import { getSlackUserIdentity, postDelayedSlackResponse } from "@/lib/slack";
import { findProfileByEmail, getActiveGmailAccountLinksForProfile, getLeadTeamsForUser, getTeamById } from "@/lib/supabase";

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

  if (command && command !== "/link") {
    return NextResponse.json({
      response_type: "ephemeral",
      text: "This endpoint is for `/link` and `/scanemail`. Usage: `/link your-mailbox@gmail.com` or `/scanemail 7`",
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
      const results = await Promise.all(
        links.map(async (link) => {
          const team = await getTeamById(link.team_id);
          const result = await syncGmailLinkForDays(link, days);
          return {
            teamName: team?.name || "your team",
            gmailEmail: link.gmail_email,
            result,
          };
        }),
      );

      const summaryLines = results.map(
        ({ teamName, gmailEmail, result }) =>
          `• ${teamName} (${gmailEmail}): checked ${result.unreadCount} unread email(s), drafted ${result.processed} receipt review message(s).`,
      );

      await postDelayedSlackResponse(
        params.responseUrl,
        `Email scan complete for the last ${days} day(s).\n${summaryLines.join("\n")}`,
      );
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
