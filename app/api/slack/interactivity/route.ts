import { after, NextResponse } from "next/server";
import { parse } from "node:querystring";
import { verifySlackSignature } from "@/lib/slack-signature";
import { getEnv } from "@/lib/env";
import { buildSlackOAuthLink } from "@/lib/gmail-receipts";
import { recordAuditEvent } from "@/lib/audit";
import { decodeActionValue, decodeAmazonClaimValue, decodeAttachmentSelectValue, isGmailPendingReceiptPayload } from "@/lib/receipt-utils";
import { amazonClaimDecisionBlocks, receiptDecisionBlocks, receiptReviewBlocks } from "@/lib/slack-blocks";
import { getSupportedEmailAttachments, rebuildEmailIngestionAttachment } from "@/lib/gmail-receipts";
import {
  claimAmazonOrderIngestion,
  createAmazonPurchaseLog,
  approveEmailReceiptIngestion,
  createPurchaseLog,
  findProfileByEmail,
  getAmazonOrderIngestionById,
  getGmailAccountLinkById,
  getEmailReceiptIngestionById,
  getLeadTeamsForUser,
  getTeamById,
  recordEmailReceiptApproval,
  rejectEmailReceiptIngestion,
  updateEmailReceiptIngestionDraft,
  updateEmailReceiptIngestionSelection,
  uploadReceiptToStorage,
} from "@/lib/supabase";
import {
  downloadSlackFile,
  fetchFileInfo,
  getSlackUserIdentity,
  postSlackResponse,
  postDirectMessageToUser,
  postDm,
} from "@/lib/slack";
import { GmailPendingReceiptPayload } from "@/types/receipt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ActionPayload = {
  user: { id: string };
  channel?: { id: string };
  response_url?: string;
  actions?: Array<{ action_id: string; value?: string; selected_option?: { value?: string } }>;
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

  const actionValue = action?.selected_option?.value || action?.value;

  if (!action || !actionValue) {
    return NextResponse.json({ ok: true });
  }

  if (action.action_id === "cancel_receipt") {
    return NextResponse.json({
      text: "Canceled.",
      replace_original: true,
      blocks: receiptDecisionBlocks({
        status: "canceled",
        title: "Receipt Review",
        detail: "Canceled",
      }),
    });
  }

  if (action.action_id === "choose_team") {
    if (!channel) return NextResponse.json({ ok: true });
    const decoded = decodeActionValue(actionValue);
    if (decoded.source !== "slack") {
      return NextResponse.json({ text: "That receipt payload was invalid.", replace_original: false });
    }
    await postDm(
      channel,
      `Here’s the draft I extracted for *${decoded.teamName}*.`,
      receiptReviewBlocks({ teamName: decoded.teamName, payload: decoded }),
    );
    return NextResponse.json({ text: `Picked ${decoded.teamName}.`, replace_original: false });
  }

  if (action.action_id === "choose_gmail_link_team") {
    const decoded = JSON.parse(Buffer.from(actionValue, "base64url").toString("utf8")) as {
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
    const decoded = decodeActionValue(actionValue);
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

    await recordAuditEvent({
      actorId: profile.id,
      action: "purchase.added",
      targetType: "slack_receipt",
      targetId: purchaseId,
      summary: `Bot added purchase for ${decoded.teamName} on behalf of ${profile.full_name || identity.realName || identity.displayName || "Unknown user"} from Slack file "${decoded.filename}".`,
      details: {
        source: "slack",
        teamId: decoded.teamId,
        teamName: decoded.teamName,
        purchaseId,
        filename: decoded.filename,
        slackUserId: payload.user.id,
        actorName: profile.full_name || identity.realName || identity.displayName,
      },
    });

    await postDm(
      channel,
      `Logged *${decoded.extraction.item_name || decoded.extraction.merchant || "receipt purchase"}* for *${decoded.teamName}*.
Amount: ${decoded.extraction.amount_total ?? "unknown"}`,
    );

    return NextResponse.json({
      text: "Confirmed.",
      replace_original: true,
      blocks: receiptDecisionBlocks({
        status: "confirmed",
        title: "Receipt Review",
        detail: `Logged for ${decoded.teamName}.`,
      }),
    });
  }

  if (action.action_id === "claim_amazon_order") {
    const decoded = decodeAmazonClaimValue(actionValue);

    const identity = await getSlackUserIdentity(payload.user.id);
    const profile = await findProfileByEmail(identity.email);
    if (!profile) {
      return NextResponse.json({ text: "Missing HQ profile match.", replace_original: false });
    }

    const ingestion = await getAmazonOrderIngestionById(decoded.ingestionId);
    if (!ingestion) {
      return NextResponse.json({ text: "That Amazon purchase was not found.", replace_original: false });
    }

    const team = await getTeamById(decoded.teamId);
    if (!team) {
      return NextResponse.json({ text: "That team was not found.", replace_original: false });
    }

    const leadTeams = await getLeadTeamsForUser(profile.id);
    const canClaim = Boolean(profile.is_admin) || leadTeams.some((leadTeam) => leadTeam.id === decoded.teamId);
    if (!canClaim) {
      return NextResponse.json({ text: "You can only claim Amazon purchases for teams you lead unless you're an admin.", replace_original: false });
    }

    const purchaseId = crypto.randomUUID();
    const claimed = await claimAmazonOrderIngestion({
      ingestionId: decoded.ingestionId,
      teamId: decoded.teamId,
      profileId: profile.id,
      purchaseLogId: purchaseId,
    });

    if (!claimed) {
      return NextResponse.json({ text: "That Amazon purchase was already claimed.", replace_original: false });
    }

    await createAmazonPurchaseLog({
      purchaseId,
      teamId: decoded.teamId,
      profileId: profile.id,
      personName: profile.full_name || identity.realName || identity.displayName,
      itemName: ingestion.item_name || "Amazon order",
      amountTotal: ingestion.amount_total || 0,
      purchaseDate: ingestion.purchase_date,
    });

    await recordAuditEvent({
      actorId: profile.id,
      action: "purchase.added",
      targetType: "amazon_order_ingestion",
      targetId: decoded.ingestionId,
      summary: `Bot added Amazon purchase for ${team.name} on behalf of ${profile.full_name || identity.realName || identity.displayName || "Unknown user"}.`,
      details: {
        source: "amazon",
        teamId: decoded.teamId,
        teamName: team.name,
        purchaseId,
        ingestionId: decoded.ingestionId,
        itemName: ingestion.item_name,
        amountTotal: ingestion.amount_total,
        currency: ingestion.currency,
        purchaseDate: ingestion.purchase_date,
        slackUserId: payload.user.id,
        actorName: profile.full_name || identity.realName || identity.displayName,
        automated: true,
      },
    });

    return NextResponse.json({
      text: `Claimed by ${team.name}`,
      replace_original: true,
      blocks: amazonClaimDecisionBlocks({ teamName: team.name }),
    });
  }

  if (action.action_id === "confirm_email_receipt" || action.action_id === "reject_email_receipt") {
    if (!channel) return NextResponse.json({ ok: true });
    const decoded = decodeActionValue(actionValue);
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

    if (action.action_id === "reject_email_receipt") {
      await recordEmailReceiptApproval({
        ingestionId: decoded.ingestionId,
        leadProfileId: profile.id,
        slackUserId: payload.user.id,
        decision: "rejected",
      });
      const rejected = await rejectEmailReceiptIngestion({
        ingestionId: decoded.ingestionId,
        approverProfileId: profile.id,
      });
      if (!rejected) {
        await postDm(channel, "That email receipt was already handled.");
        return NextResponse.json({ text: "Already processed.", replace_original: false });
      }

      return NextResponse.json({
        text: "Rejected.",
        replace_original: true,
        blocks: receiptDecisionBlocks({
          status: "rejected",
          title: "Automated Receipt Review",
          detail: "Rejected",
        }),
      });
    }

    const responseUrl = payload.response_url;
    if (!responseUrl) {
      return NextResponse.json({ text: "Slack did not include a response URL for this action.", replace_original: false });
    }

    after(async () => {
      try {
        const current = await getEmailReceiptIngestionById(decoded.ingestionId);
        if (!current) {
          await postSlackResponse(responseUrl, {
            text: "That email receipt was not found.",
            replace_original: false,
            response_type: "ephemeral",
          });
          return;
        }

        let finalIngestion = current;
        const storedSelectedAttachmentPartId =
          current.slack_dm_message_refs?.find((ref) => ref.slack_user_id === payload.user.id && ref.channel === channel)
            ?.selected_attachment_part_id ?? null;
        const selectedAttachmentPartId = storedSelectedAttachmentPartId || decoded.selectedAttachmentPartId || null;

        if (selectedAttachmentPartId) {
          const link = await getGmailAccountLinkById(current.gmail_link_id);
          if (!link) {
            await postSlackResponse(responseUrl, {
              text: "That Gmail link is no longer active.",
              replace_original: false,
              response_type: "ephemeral",
            });
            return;
          }

          const rebuilt = await rebuildEmailIngestionAttachment({
            link,
            teamId: current.team_id,
            messageId: current.gmail_message_id,
            attachmentPartId: selectedAttachmentPartId,
          });

          if (rebuilt.extraction.confidence < 0.5) {
            await postSlackResponse(responseUrl, {
              text: `Selected file *${rebuilt.artifactFilename}* is under 50% confidence, so it was not logged.`,
              replace_original: false,
              response_type: "ephemeral",
            });
            return;
          }

          await updateEmailReceiptIngestionDraft({
            ingestionId: current.id,
            artifactSource: rebuilt.artifactSource,
            artifactFilename: rebuilt.artifactFilename,
            artifactMimeType: rebuilt.artifactMimeType,
            artifactStoragePath: rebuilt.artifactStoragePath,
            extraction: rebuilt.extraction,
          });

          const refreshed = await getEmailReceiptIngestionById(decoded.ingestionId);
          if (!refreshed) {
            throw new Error(`Email ingestion ${decoded.ingestionId} disappeared before approval.`);
          }
          finalIngestion = refreshed;
        }

        await recordEmailReceiptApproval({
          ingestionId: decoded.ingestionId,
          leadProfileId: profile.id,
          slackUserId: payload.user.id,
          decision: "approved",
        });

        const approved = await approveEmailReceiptIngestion({
          ingestionId: decoded.ingestionId,
          approverProfileId: profile.id,
        });

        if (!approved) {
          await postSlackResponse(responseUrl, {
            text: "That email receipt was already handled.",
            replace_original: false,
            response_type: "ephemeral",
          });
          return;
        }

        const team = await getTeamById(approved.team_id);
        if (!team) {
          throw new Error(`Team ${approved.team_id} was not found after approval.`);
        }

        const gmailPayload: GmailPendingReceiptPayload = {
          source: "gmail",
          ingestionId: finalIngestion.id,
          teamId: finalIngestion.team_id,
          teamName: team.name,
          filename: finalIngestion.artifact_filename,
          mimeType: finalIngestion.artifact_mime_type,
          artifactSource: finalIngestion.artifact_source,
          senderEmail: finalIngestion.sender_email,
          subject: finalIngestion.subject,
          extraction: finalIngestion.extraction,
          selectedAttachmentPartId,
          attachmentOptions: decoded.attachmentOptions,
        };

        const { purchaseId } = await createPurchaseLog({
          payload: gmailPayload,
          profileId: profile.id,
          personName: profile.full_name || identity.realName || identity.displayName,
          receipt: {
            receipt_path: finalIngestion.artifact_storage_path,
            receipt_file_name: finalIngestion.artifact_filename,
            receipt_uploaded_at: finalIngestion.received_at || new Date().toISOString(),
          },
        });

        await recordAuditEvent({
          actorId: profile.id,
          action: "purchase.added",
          targetType: "email_receipt_ingestion",
          targetId: finalIngestion.id,
          summary: `Bot added purchase for ${team.name} on behalf of ${profile.full_name || identity.realName || identity.displayName || "Unknown user"} from email "${finalIngestion.subject || "No subject"}".`,
          details: {
            source: "gmail",
            teamId: finalIngestion.team_id,
            teamName: team.name,
            purchaseId,
            ingestionId: finalIngestion.id,
            subject: finalIngestion.subject,
            senderEmail: finalIngestion.sender_email,
            filename: finalIngestion.artifact_filename,
            slackUserId: payload.user.id,
            actorName: profile.full_name || identity.realName || identity.displayName,
            automated: true,
          },
        });

        await postDm(
          channel,
          `Logged *${finalIngestion.extraction.item_name || finalIngestion.extraction.merchant || "receipt purchase"}* for *${team.name}* from *${finalIngestion.artifact_filename}*.
Amount: ${finalIngestion.extraction.amount_total ?? "unknown"}`,
        );

        await postSlackResponse(responseUrl, {
          text: "Confirmed.",
          replace_original: true,
          blocks: receiptDecisionBlocks({
            status: "confirmed",
            title: "Automated Receipt Review",
            detail: `Logged ${finalIngestion.artifact_filename}.`,
          }),
        });
      } catch (error) {
        await postSlackResponse(responseUrl, {
          text: `Receipt logging failed: ${error instanceof Error ? error.message : String(error)}`,
          replace_original: false,
          response_type: "ephemeral",
        });
      }
    });

    return NextResponse.json({ text: "Logging selected receipt...", replace_original: false });
  }

  if (action.action_id === "select_email_attachment") {
    if (!channel) return NextResponse.json({ ok: true });
    const decoded = decodeAttachmentSelectValue(actionValue);
    const responseUrl = payload.response_url;

    if (!responseUrl) {
      return NextResponse.json({ text: "Slack did not include a response URL for this selection.", replace_original: false });
    }

    after(async () => {
      try {
        const identity = await getSlackUserIdentity(payload.user.id);
        const profile = await findProfileByEmail(identity.email);
        if (!profile) {
          await postSlackResponse(responseUrl, {
            text: `I couldn't match your Slack email (${identity.email}) to an SSR HQ profile.`,
            replace_original: false,
            response_type: "ephemeral",
          });
          return;
        }

        const current = await getEmailReceiptIngestionById(decoded.ingestionId);
        if (!current) {
          await postSlackResponse(responseUrl, {
            text: "That email receipt was not found.",
            replace_original: false,
            response_type: "ephemeral",
          });
          return;
        }

        const leadTeams = await getLeadTeamsForUser(profile.id);
        const authorized = leadTeams.some((team) => team.id === current.team_id);
        if (!authorized) {
          await postSlackResponse(responseUrl, {
            text: "You are no longer authorized to review receipts for that team.",
            replace_original: false,
            response_type: "ephemeral",
          });
          return;
        }

        const link = await getGmailAccountLinkById(current.gmail_link_id);
        if (!link) {
          await postSlackResponse(responseUrl, {
            text: "That Gmail link is no longer active.",
            replace_original: false,
            response_type: "ephemeral",
          });
          return;
        }

        const { attachments } = await getSupportedEmailAttachments(link, current.gmail_message_id);
        await updateEmailReceiptIngestionSelection({
          ingestionId: current.id,
          slackUserId: payload.user.id,
          channel,
          attachmentPartId: decoded.attachmentPartId,
        });
        const rebuilt = await rebuildEmailIngestionAttachment({
          link,
          teamId: current.team_id,
          messageId: current.gmail_message_id,
          attachmentPartId: decoded.attachmentPartId,
        });

        if (rebuilt.extraction.confidence < 0.5) {
          const selectedFilename =
            attachments.find((attachment) => attachment.partId === decoded.attachmentPartId)?.filename || "that attachment";
          await postSlackResponse(responseUrl, {
            text: `Skipped *${selectedFilename}* because the extracted confidence was under 50%. Pick another file if you want.`,
            replace_original: false,
            response_type: "ephemeral",
          });
          return;
        }

        await updateEmailReceiptIngestionDraft({
          ingestionId: current.id,
          artifactSource: rebuilt.artifactSource,
          artifactFilename: rebuilt.artifactFilename,
          artifactMimeType: rebuilt.artifactMimeType,
          artifactStoragePath: rebuilt.artifactStoragePath,
          extraction: rebuilt.extraction,
        });

        const updatedPayload: GmailPendingReceiptPayload = {
          source: "gmail",
          ingestionId: current.id,
          teamId: current.team_id,
          teamName: current.teamName,
          filename: rebuilt.artifactFilename,
          mimeType: rebuilt.artifactMimeType,
          artifactSource: rebuilt.artifactSource,
          senderEmail: current.sender_email,
          subject: current.subject,
          extraction: rebuilt.extraction,
          selectedAttachmentPartId: decoded.attachmentPartId,
          attachmentOptions: attachments.map((attachment) => ({
            partId: attachment.partId,
            filename: attachment.filename,
          })),
        };

        await postSlackResponse(responseUrl, {
          text: `Updated draft to use ${rebuilt.artifactFilename}.`,
          replace_original: true,
          blocks: receiptReviewBlocks({ teamName: current.teamName, payload: updatedPayload }),
        });
      } catch (error) {
        await postSlackResponse(responseUrl, {
          text: `Attachment update failed: ${error instanceof Error ? error.message : String(error)}`,
          replace_original: false,
          response_type: "ephemeral",
        });
      }
    });

    return NextResponse.json({
      text: "Updating receipt draft...",
      replace_original: false,
    });
  }

  return NextResponse.json({ ok: true });
}
