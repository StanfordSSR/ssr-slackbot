import { GmailAttachmentChoicePayload, LeadTeam, PendingReceiptPayload, ReceiptExtraction } from "@/types/receipt";
import { encodeActionValue, encodeAttachmentSelectValue, isGmailPendingReceiptPayload, prettyCurrency } from "@/lib/receipt-utils";

export function receiptReviewBlocks(params: { teamName: string; payload: PendingReceiptPayload }) {
  const { teamName, payload } = params;
  const receipt = payload.extraction;
  const isGmail = isGmailPendingReceiptPayload(payload);
  const sourceLabel = isGmail ? (payload.artifactSource === "attachment" ? "Email attachment" : "Email PDF") : "Slack upload";
  const fields = [
    { type: "mrkdwn", text: `*Team*\n${teamName}` },
    { type: "mrkdwn", text: `*Source*\n${sourceLabel}` },
    { type: "mrkdwn", text: `*Merchant*\n${receipt.merchant ?? "Unknown"}` },
    { type: "mrkdwn", text: `*Amount*\n${prettyCurrency(receipt.amount_total, receipt.currency)}` },
    { type: "mrkdwn", text: `*Date*\n${receipt.purchase_date ?? "Unknown"}` },
    { type: "mrkdwn", text: `*Item*\n${receipt.item_name ?? "Unknown"}` },
    { type: "mrkdwn", text: `*Category*\n${receipt.category}` },
    { type: "mrkdwn", text: `*Payment*\n${receipt.payment_method}` },
    { type: "mrkdwn", text: `*Confidence*\n${Math.round(receipt.confidence * 100)}%` },
    { type: "mrkdwn", text: `*Receipt file*\n${payload.filename}` },
  ];

  const blocks: unknown[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Automated Receipt Review*",
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: isGmail
            ? "Generated from Gmail intake. Review the extracted details before logging."
            : "Generated from a Slack upload. Review the extracted details before logging.",
        },
      ],
    },
    {
      type: "divider",
    },
    {
      type: "section",
      fields,
    },
  ];

  if (isGmail) {
    blocks.push({
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*From*\n${payload.senderEmail ?? "Unknown"}` },
        { type: "mrkdwn", text: `*Subject*\n${payload.subject ?? "Unknown"}` },
      ],
    });
  }

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*Notes*\n${receipt.notes ?? "None"}`,
    },
  });

  if (isGmail && payload.attachmentOptions && payload.attachmentOptions.length > 1) {
    const selectedAttachment =
      payload.attachmentOptions.find((attachment) => attachment.partId === payload.selectedAttachmentPartId) || payload.attachmentOptions[0];
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "static_select",
          action_id: "select_email_attachment",
          placeholder: {
            type: "plain_text",
            text: "Choose receipt file",
          },
          initial_option: {
            text: {
              type: "plain_text",
              text: selectedAttachment.filename.slice(0, 75),
            },
            value: encodeAttachmentSelectValue(payload.ingestionId, selectedAttachment.partId),
          },
          options: payload.attachmentOptions.slice(0, 100).map((attachment) => ({
            text: {
              type: "plain_text",
              text: attachment.filename.slice(0, 75),
            },
            value: encodeAttachmentSelectValue(payload.ingestionId, attachment.partId),
          })),
        },
      ],
    });
  }

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Confirm" },
        style: "primary",
        action_id: isGmail ? "confirm_email_receipt" : "confirm_receipt",
        value: encodeActionValue(payload),
      },
      {
        type: "button",
        text: { type: "plain_text", text: isGmail ? "Reject" : "Cancel" },
        style: isGmail ? undefined : "danger",
        action_id: isGmail ? "reject_email_receipt" : "cancel_receipt",
        value: encodeActionValue(payload),
      },
    ],
  });

  return blocks;
}
export function teamChoiceBlocks(params: {
  teams: LeadTeam[];
  extraction: ReceiptExtraction;
  fileId: string;
  filename: string;
  mimeType: string;
}) {
  const shared = {
    source: "slack" as const,
    fileId: params.fileId,
    filename: params.filename,
    mimeType: params.mimeType,
    extraction: params.extraction,
  };

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "You lead multiple teams. Pick where this receipt should go.",
      },
    },
    {
      type: "actions",
      elements: params.teams.slice(0, 5).map((team) => ({
        type: "button",
        text: { type: "plain_text", text: team.name },
        action_id: "choose_team",
        value: encodeActionValue({ ...shared, teamId: team.id, teamName: team.name }),
      })),
    },
  ];
}

export function gmailLinkTeamChoiceBlocks(params: { teams: LeadTeam[]; gmailEmail: string }) {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Pick which team should use *${params.gmailEmail}* for Gmail receipt intake.`,
      },
    },
    {
      type: "actions",
      elements: params.teams.slice(0, 5).map((team) => ({
        type: "button",
        text: { type: "plain_text", text: team.name },
        action_id: "choose_gmail_link_team",
        value: Buffer.from(JSON.stringify({ teamId: team.id, teamName: team.name, gmailEmail: params.gmailEmail }), "utf8").toString(
          "base64url",
        ),
      })),
    },
  ];
}

export function gmailAttachmentChoiceBlocks(params: {
  teamName: string;
  ingestionId: string;
  teamId: string;
  attachments: Array<{ partId: string; filename: string }>;
}) {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Multiple receipt files were attached for *${params.teamName}*. Pick which file to log.`,
      },
    },
    {
      type: "actions",
      elements: params.attachments.slice(0, 5).map((attachment) => ({
        type: "button",
        text: { type: "plain_text", text: attachment.filename.slice(0, 75) },
        action_id: "choose_email_attachment",
        value: encodeActionValue({
          source: "gmail_attachment_choice",
          ingestionId: params.ingestionId,
          teamId: params.teamId,
          teamName: params.teamName,
          attachmentPartId: attachment.partId,
          filename: attachment.filename,
        } satisfies GmailAttachmentChoicePayload),
      })),
    },
  ];
}
