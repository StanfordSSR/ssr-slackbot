import { NextResponse } from "next/server";
import { parse } from "node:querystring";
import { verifySlackSignature } from "@/lib/slack-signature";
import { getEnv } from "@/lib/env";
import { after } from "next/server";
import { buildAmazonOAuthLink, syncActiveAmazonAccountForDays } from "@/lib/amazon-orders";
import { runAnalystSession } from "@/lib/analyst";
import { ingestUrlContext, parseAddContextInput } from "@/lib/context-ingestion";
import { refreshSchemaCatalog } from "@/lib/schema-sql";
import { buildSlackOAuthLink, syncGmailLinkForDays } from "@/lib/gmail-receipts";
import { syncProfileSlackUsers } from "@/lib/slack-users";
import { appendUsersToUserGroup, getEligibleChannelMemberIds, resolveEmailsOrMentionsToUserIds } from "@/lib/slack-usergroups";
import { gmailLinkTeamChoiceBlocks } from "@/lib/slack-blocks";
import { getSlackUserIdentity, postDelayedSlackResponse, postSlackResponse } from "@/lib/slack";
import {
  findProfileByEmail,
  getActiveAmazonAccountLink,
  getActiveGmailAccountLinksForProfile,
  getLeadTeamsForUser,
  getTeamById,
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

  if (command === "/analyze") {
    return handleAnalyzeCommand({ text, slackUserId, responseUrl });
  }

  if (command === "/addcontext") {
    return handleAddContextCommand({ text, slackUserId, responseUrl });
  }

  if (command === "/slackusersync") {
    return handleSlackUserSyncCommand({ slackUserId, responseUrl });
  }

  if (command === "/refreshschema") {
    return handleRefreshSchemaCommand({ slackUserId, responseUrl });
  }

  if (command === "/ug-add") {
    return handleUserGroupAddCommand({ text, slackUserId, responseUrl });
  }

  if (command === "/ug-sync-channel") {
    return handleUserGroupSyncChannelCommand({ text, slackUserId, responseUrl });
  }

  if (command && command !== "/link") {
    return NextResponse.json({
      response_type: "ephemeral",
      text: "This endpoint is for `/link`, `/scanemail`, `/amazonlink`, `/amazonsync`, `/analyze`, `/addcontext`, `/slackusersync`, `/refreshschema`, `/ug-add`, and `/ug-sync-channel`.",
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
    try {
      const result = await syncProfileSlackUsers();

      await postSlackResponse(params.responseUrl, {
        replace_original: true,
        text: `Slack user sync finished. Added ${result.matched}, already linked ${result.alreadyLinked}, failed ${result.failed}.`,
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

async function handleAnalyzeCommand(params: { text: string; slackUserId: string; responseUrl: string }) {
  const prompt = params.text.trim();
  if (!prompt) {
    return NextResponse.json({
      response_type: "ephemeral",
      text: "Usage: `/analyze <question>`",
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

  after(async () => {
    try {
      const answer = await runAnalystSession({
        caller: {
          slackUserId: params.slackUserId,
          profileId: profile.id,
          isAdmin: Boolean(profile.is_admin),
          entrypoint: "slash_command",
        },
        prompt,
        history: [],
        onProgress: async (_stage, detail) => {
          await postSlackResponse(params.responseUrl, {
            replace_original: true,
            text: `Analyzing... ${detail}`,
          });
        },
      });

      const finalText = "lightweight" in answer && answer.lightweight ? await simpleAnalyzeReply(prompt) : answer.answer;
      await postSlackResponse(params.responseUrl, {
        replace_original: true,
        text: finalText,
      });
    } catch (error) {
      await postDelayedSlackResponse(
        params.responseUrl,
        `Analysis failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  return NextResponse.json({
    response_type: "ephemeral",
    text: "Starting analysis. I’ll replace this with the result when it finishes.",
  });
}

async function handleAddContextCommand(params: { text: string; slackUserId: string; responseUrl: string }) {
  const { url, parsed } = parseAddContextInput(params.text);
  if (!url) {
    return NextResponse.json({
      response_type: "ephemeral",
      text: "Usage: `/addcontext <url> [internal|org] [canonical[:kind]] [team:<uuid>] [tag:<name>]`",
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
      text: "Only admins or active team leads can add context sources.",
    });
  }

  after(async () => {
    try {
      const result = await ingestUrlContext({
        linkedByProfileId: profile.id,
        url,
        corpus: parsed.corpus,
        scope: parsed.scope,
        teamId: parsed.teamId,
        tags: parsed.tags,
        isCanonical: parsed.isCanonical,
        canonicalKind: parsed.canonicalKind,
      });

      await postSlackResponse(params.responseUrl, {
        replace_original: true,
        text: `Indexed context: ${result.title}\n${result.contentSummary.slice(0, 250)}`,
      });
    } catch (error) {
      await postDelayedSlackResponse(
        params.responseUrl,
        `Context ingestion failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  return NextResponse.json({
    response_type: "ephemeral",
    text: "Indexing that context source now. I’ll replace this with the result when it finishes.",
  });
}

async function handleRefreshSchemaCommand(params: { slackUserId: string; responseUrl: string }) {
  const identity = await getSlackUserIdentity(params.slackUserId);
  const profile = await findProfileByEmail(identity.email);
  if (!profile?.is_admin) {
    return NextResponse.json({
      response_type: "ephemeral",
      text: "Only admins can run `/refreshschema`.",
    });
  }

  after(async () => {
    try {
      const result = await refreshSchemaCatalog();
      await postSlackResponse(params.responseUrl, {
        replace_original: true,
        text: `Schema refresh finished. Tables ${result.refreshedTables}, columns ${result.refreshedColumns}, relationships ${result.refreshedRelationships}.`,
      });
    } catch (error) {
      await postDelayedSlackResponse(
        params.responseUrl,
        `Schema refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  return NextResponse.json({
    response_type: "ephemeral",
    text: "Refreshing the schema catalog now. I’ll replace this with the result when it finishes.",
  });
}

function isSlackWorkspaceAdmin(identity: Awaited<ReturnType<typeof getSlackUserIdentity>>) {
  return Boolean(identity.isAdmin || identity.isOwner || identity.isPrimaryOwner);
}

function normalizeUserGroupHandle(value: string) {
  return value.trim().replace(/^@/, "").toLowerCase();
}

function buildUserGroupResultMessage(params: {
  handle: string;
  addedCount: number;
  notFound?: string[];
  skippedGuestsOrBots?: number;
  channelLabel?: string;
}) {
  const lines = [`✅ Added ${params.addedCount} user${params.addedCount === 1 ? "" : "s"} to @${params.handle}`];

  if (params.channelLabel) {
    lines[0] = `✅ Added ${params.addedCount} user${params.addedCount === 1 ? "" : "s"} from ${params.channelLabel} to @${params.handle}`;
  }

  if ((params.skippedGuestsOrBots ?? 0) > 0) {
    lines.push(`⚠️ Skipped ${params.skippedGuestsOrBots} guest/bot account(s).`);
  }

  if ((params.notFound?.length ?? 0) > 0) {
    lines.push(`⚠️ ${params.notFound!.length} entr${params.notFound!.length === 1 ? "y was" : "ies were"} not found:`);
    for (const item of params.notFound!) {
      lines.push(`- ${item}`);
    }
  }

  return lines.join("\n");
}

async function handleUserGroupAddCommand(params: { text: string; slackUserId: string; responseUrl: string }) {
  const match = params.text.match(/^(\S+)\s+(.+)$/);
  if (!match) {
    return NextResponse.json({
      response_type: "ephemeral",
      text: "Usage: `/ug-add group_handle emails_or_usernames`",
    });
  }

  const identity = await getSlackUserIdentity(params.slackUserId);
  if (!isSlackWorkspaceAdmin(identity)) {
    return NextResponse.json({
      response_type: "ephemeral",
      text: "❌ You do not have permission to use this command.",
    });
  }

  const groupHandle = normalizeUserGroupHandle(match[1]);
  const rawTargets = match[2];

  after(async () => {
    try {
      const resolved = await resolveEmailsOrMentionsToUserIds(rawTargets);
      const result = await appendUsersToUserGroup({
        groupHandle,
        userIds: resolved.userIds,
      });

      await postSlackResponse(params.responseUrl, {
        replace_original: true,
        text: buildUserGroupResultMessage({
          handle: result.normalizedHandle,
          addedCount: result.addedCount,
          notFound: resolved.notFound,
        }),
      });
    } catch (error) {
      await postDelayedSlackResponse(
        params.responseUrl,
        `User group update failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  return NextResponse.json({
    response_type: "ephemeral",
    text: `Updating @${groupHandle} now. I’ll replace this with the result when it finishes.`,
  });
}

async function handleUserGroupSyncChannelCommand(params: { text: string; slackUserId: string; responseUrl: string }) {
  const match = params.text.match(/^(\S+)\s+(.+)$/);
  if (!match) {
    return NextResponse.json({
      response_type: "ephemeral",
      text: "Usage: `/ug-sync-channel group_handle #channel-name`",
    });
  }

  const identity = await getSlackUserIdentity(params.slackUserId);
  if (!isSlackWorkspaceAdmin(identity)) {
    return NextResponse.json({
      response_type: "ephemeral",
      text: "❌ You do not have permission to use this command.",
    });
  }

  const groupHandle = normalizeUserGroupHandle(match[1]);
  const channelReference = match[2].trim();

  after(async () => {
    try {
      const members = await getEligibleChannelMemberIds(channelReference);
      if (!members.channelId) {
        await postSlackResponse(params.responseUrl, {
          replace_original: true,
          text: `I couldn't find a Slack channel matching ${channelReference}.`,
        });
        return;
      }

      const result = await appendUsersToUserGroup({
        groupHandle,
        userIds: members.eligibleUserIds,
      });

      await postSlackResponse(params.responseUrl, {
        replace_original: true,
        text: buildUserGroupResultMessage({
          handle: result.normalizedHandle,
          addedCount: result.addedCount,
          skippedGuestsOrBots: members.skippedGuestsOrBots.length,
          channelLabel: channelReference,
        }),
      });
    } catch (error) {
      await postDelayedSlackResponse(
        params.responseUrl,
        `Channel sync failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  return NextResponse.json({
    response_type: "ephemeral",
    text: `Syncing ${channelReference} into @${groupHandle} now. I’ll replace this with the result when it finishes.`,
  });
}

async function simpleAnalyzeReply(prompt: string) {
  const normalized = prompt.trim().toLowerCase();
  if (/^(hi|hey|hello|yo|sup)[!.?]*$/.test(normalized)) {
    return "Hey! What do you want me to look into?";
  }
  if (/^(thanks|thank you|ty)[!.?]*$/.test(normalized)) {
    return "Anytime.";
  }
  return `I’m ready. Ask a specific SSR, finance, fundraising, or policy question and I’ll dig in.`;
}
