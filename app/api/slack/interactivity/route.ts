import { NextResponse } from "next/server";
import { parse } from "node:querystring";
import { verifySlackSignature } from "@/lib/slack-signature";
import { getEnv } from "@/lib/env";
import { postDm, fetchFileInfo, downloadSlackFile, getSlackUserIdentity } from "@/lib/slack";
import { decodeActionValue } from "@/lib/receipt-utils";
import { findProfileByEmail, getLeadTeamsForUser, uploadReceiptToStorage, createPurchaseLog } from "@/lib/supabase";
import { receiptReviewBlocks } from "@/lib/slack-blocks";

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

  if (!action || !channel || !action.value) {
    return NextResponse.json({ ok: true });
  }

  if (action.action_id === "cancel_receipt") {
    await postDm(channel, "Canceled. Send another receipt any time.");
    return NextResponse.json({ text: "Receipt canceled.", replace_original: false });
  }

  if (action.action_id === "choose_team") {
    const decoded = decodeActionValue(action.value);
    await postDm(
      channel,
      `Here’s the draft I extracted for *${decoded.teamName}*.`,
      receiptReviewBlocks({ teamName: decoded.teamName, payload: decoded }),
    );
    return NextResponse.json({ text: `Picked ${decoded.teamName}.`, replace_original: false });
  }

  if (action.action_id === "confirm_receipt") {
    const decoded = decodeActionValue(action.value);
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

  return NextResponse.json({ ok: true });
}
