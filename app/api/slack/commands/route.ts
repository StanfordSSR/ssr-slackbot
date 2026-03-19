import { NextResponse } from "next/server";
import { parse } from "node:querystring";
import { verifySlackSignature } from "@/lib/slack-signature";
import { getEnv } from "@/lib/env";
import { buildSlackOAuthLink } from "@/lib/gmail-receipts";
import { gmailLinkTeamChoiceBlocks } from "@/lib/slack-blocks";
import { getSlackUserIdentity } from "@/lib/slack";
import { findProfileByEmail, getLeadTeamsForUser } from "@/lib/supabase";

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

  if (command && command !== "/link") {
    return NextResponse.json({
      response_type: "ephemeral",
      text: "This endpoint is for /link. Usage: `/link your-mailbox@gmail.com`",
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
