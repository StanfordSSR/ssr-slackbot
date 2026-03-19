import { NextResponse } from "next/server";
import { parse } from "node:querystring";
import { verifySlackSignature } from "@/lib/slack-signature";
import { getEnv } from "@/lib/env";
import { buildSlackOAuthLink } from "@/lib/gmail-receipts";
import { decodeActionValue, isGmailPendingReceiptPayload } from "@/lib/receipt-utils";
import { receiptReviewBlocks } from "@/lib/slack-blocks";
import {
  approveEmailReceiptIngestion,
  createPurchaseLog,
  findProfileByEmail,
  getEmailReceiptIngestionById,
  getLeadTeamsForUser,
  getTeamById,
  recordEmailReceiptApproval,
  rejectEmailReceiptIngestion,
  uploadReceiptToStorage,
} from "@/lib/supabase";
import {
  downloadSlackFile,
  fetchFileInfo,
  getSlackUserIdentity,
  postDirectMessageToUser,
  postDm,
} from "@/lib/slack";
import { GmailPendingReceiptPayload } from "@/types/receipt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ActionPayload = {
  user: { id: string };
  channel?: { id: string };
  actions?: Array<{ action_id: string; value?: string }>;
};

export async function POST(request: Request) {
  const rawBody = await request.text();
  const signingSecret = getEnv("SLACK_SIGNING_SECRET")!;
  const isValid = await verifySlackSignature(request, rawBody, signingSecret);

  if (!isValid) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  const body = parse(rawBody);
  const payloadRaw = body.payload;
  if (!payloadRaw || typeof payloadRaw !== "string") {
    return NextResponse.json({ ok: true });
  }

  const payload = JSON.parse(payloadRaw) as ActionPayload;
  const action = payload.actions?.[0];
  const channel = payload.channel?.id;

  if (!action || !action.value) {
    return NextResponse.json({ ok: true });
  }

  if (action.action_id === "cancel_receipt") {
    if (channel) await postDm(channel, "Canceled. Send another receipt any time.");
    return NextResponse.json({ text: "Receipt canceled.", replace_original: false });
  }

  if (action.action_id === "choose_team") {
    if (!channel) return NextResponse.json({ ok: true });
    const decoded = decodeActionValue(action.value);
    await postDm(
      channel,
      `Here’s the draft I extracted for *${decoded.teamName}*.`,
      receiptReviewBlocks({ teamName: decoded.teamName, payload: decoded }),
    );
    return NextResponse.json({ text: `Picked ${decoded.teamName}.`, replace_original: false });
  }

  if (action.action_id === "choose_gmail_link_team") {
    const decoded = JSON.parse(Buffer.from(action.value, "base64url").toString("utf8")) as {
      teamId: string;
      teamName: string;
      gmailEmail: string;
    };
    const identity = await getSlackUserIdentity(payload.user.id);
    const profile = await findProfileByEmail(identity.email);
    if (!profile) {
      return NextResponse.json({ text: "Missing HQ profile match.", replace_original: false });
    }

    const oauthUrl = await buildSlackOAuthLink({
      slackUserId: payload.user.id,
      profileId: profile.id,
      teamId: decoded.teamId,
      gmailEmail: decoded.gmailEmail,
    });

    await postDirectMessageToUser(
      payload.user.id,
      `Connect *${decoded.gmailEmail}* for *${decoded.teamName}*: ${oauthUrl}`,
    );

    return NextResponse.json({ text: `Sent your Gmail link for ${decoded.teamName} in DM.`, replace_original: false });
  }

  if (action.action_id === "confirm_receipt") {
    if (!channel) return NextResponse.json({ ok: true });
    const decoded = decodeActionValue(action.value);
    if (decoded.source !== "slack") {
      return NextResponse.json({ text: "That receipt payload was invalid.", replace_original: false });
    }
    const identity = await getSlackUserIdentity(payload.user.id);
    const profile = await findProfileByEmail(identity.email);

    if (!profile) {
      await postDm(channel, `I couldn't match your Slack email (${identity.email}) to an SSR HQ profile.`);
      return NextResponse.json({ text: "Missing HQ profile match.", replace_original: false });
    }

    const leadTeams = await getLeadTeamsForUser(profile.id);
    const authorized = leadTeams.some((team) => team.id === decoded.teamId);
    if (!authorized) {
      await postDm(channel, "You are no longer authorized to submit receipts for that team.");
      return NextResponse.json({ text: "Not authorized.", replace_original: false });
    }

    const fileInfo = await fetchFileInfo(decoded.fileId);
    const slackFile = fileInfo.file as {
      id: string;
      mimetype?: string;
      name?: string;
      url_private_download?: string;
    };

    if (!slackFile.url_private_download) {
      throw new Error("Slack did not provide a private download URL for the receipt.");
    }

    const fileBytes = await downloadSlackFile(slackFile.url_private_download);
    const purchaseId = crypto.randomUUID();
    const receipt = await uploadReceiptToStorage({
      teamId: decoded.teamId,
      purchaseId,
      fileBytes: fileBytes.arrayBuffer,
      mimeType: decoded.mimeType || slackFile.mimetype || fileBytes.contentType,
      filename: decoded.filename || slackFile.name || "receipt",
    });

    await createPurchaseLog({
      purchaseId,
      payload: decoded,
      profileId: profile.id,
      personName: profile.full_name || identity.realName || identity.displayName,
      receipt,
    });

    await postDm(
      channel,
      `Logged *${decoded.extraction.item_name || decoded.extraction.merchant || "receipt purchase"}* for *${decoded.teamName}*.
Amount: ${decoded.extraction.amount_total ?? "unknown"}`,
    );

    return NextResponse.json({ text: "Receipt logged.", replace_original: false });
  }

  if (action.action_id === "confirm_email_receipt" || action.action_id === "reject_email_receipt") {
    if (!channel) return NextResponse.json({ ok: true });
    const decoded = decodeActionValue(action.value);
    if (!isGmailPendingReceiptPayload(decoded)) {
      return NextResponse.json({ text: "That Gmail receipt payload was invalid.", replace_original: false });
    }

    const identity = await getSlackUserIdentity(payload.user.id);
    const profile = await findProfileByEmail(identity.email);
    if (!profile) {
      await postDm(channel, `I couldn't match your Slack email (${identity.email}) to an SSR HQ profile.`);
      return NextResponse.json({ text: "Missing HQ profile match.", replace_original: false });
    }

    const leadTeams = await getLeadTeamsForUser(profile.id);
    const authorized = leadTeams.some((team) => team.id === decoded.teamId);
    if (!authorized) {
      await postDm(channel, "You are no longer authorized to review receipts for that team.");
      return NextResponse.json({ text: "Not authorized.", replace_original: false });
    }

    await recordEmailReceiptApproval({
      ingestionId: decoded.ingestionId,
      leadProfileId: profile.id,
      slackUserId: payload.user.id,
      decision: action.action_id === "confirm_email_receipt" ? "approved" : "rejected",
    });

    if (action.action_id === "reject_email_receipt") {
      const rejected = await rejectEmailReceiptIngestion({
        ingestionId: decoded.ingestionId,
        approverProfileId: profile.id,
      });
      if (!rejected) {
        await postDm(channel, "That email receipt was already handled.");
        return NextResponse.json({ text: "Already processed.", replace_original: false });
      }

      await postDm(channel, "Rejected that emailed receipt. It will not be logged.");
      return NextResponse.json({ text: "Receipt rejected.", replace_original: false });
    }

    const approved = await approveEmailReceiptIngestion({
      ingestionId: decoded.ingestionId,
      approverProfileId: profile.id,
    });

    if (!approved) {
      await postDm(channel, "That email receipt was already handled.");
      return NextResponse.json({ text: "Already processed.", replace_original: false });
    }

    const team = await getTeamById(approved.team_id);
    const current = await getEmailReceiptIngestionById(decoded.ingestionId);
    if (!current || !team) {
      throw new Error(`Email ingestion ${decoded.ingestionId} was not found after approval.`);
    }

    const gmailPayload: GmailPendingReceiptPayload = {
      source: "gmail",
      ingestionId: current.id,
      teamId: current.team_id,
      teamName: team.name,
      filename: current.artifact_filename,
      mimeType: current.artifact_mime_type,
      artifactSource: current.artifact_source,
      senderEmail: current.sender_email,
      subject: current.subject,
      extraction: current.extraction,
    };

    await createPurchaseLog({
      payload: gmailPayload,
      profileId: profile.id,
      personName: profile.full_name || identity.realName || identity.displayName,
      receipt: {
        receipt_path: current.artifact_storage_path,
        receipt_file_name: current.artifact_filename,
        receipt_uploaded_at: current.received_at || new Date().toISOString(),
      },
    });

    await postDm(
      channel,
      `Logged *${current.extraction.item_name || current.extraction.merchant || "receipt purchase"}* for *${team.name}*.
Amount: ${current.extraction.amount_total ?? "unknown"}`,
    );

    return NextResponse.json({ text: "Receipt logged.", replace_original: false });
  }

  return NextResponse.json({ ok: true });
}
