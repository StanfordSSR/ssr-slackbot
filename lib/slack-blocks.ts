import { LeadTeam, PendingReceiptPayload, ReceiptExtraction } from "@/types/receipt";
import { encodeActionValue, isGmailPendingReceiptPayload, prettyCurrency } from "@/lib/receipt-utils";

export function receiptReviewBlocks(params: { teamName: string; payload: PendingReceiptPayload }) {
  const { teamName, payload } = params;
  const receipt = payload.extraction;
  const isGmail = isGmailPendingReceiptPayload(payload);
  const sourceLabel = isGmail ? (payload.artifactSource === "attachment" ? "Email attachment" : "Email PDF") : "Slack upload";
  const summaryLines = [
    `*Team:* ${teamName}  |  *Source:* ${sourceLabel}`,
    `*Merchant:* ${receipt.merchant ?? "Unknown"}  |  *Amount:* ${prettyCurrency(receipt.amount_total, receipt.currency)}`,
    `*Date:* ${receipt.purchase_date ?? "Unknown"}  |  *Item:* ${receipt.item_name ?? "Unknown"}`,
    `*Category:* ${receipt.category}  |  *Payment:* ${receipt.payment_method}`,
    `*Confidence:* ${Math.round(receipt.confidence * 100)}%`,
  ];

  if (isGmail) {
    summaryLines.push(`*From:* ${payload.senderEmail ?? "Unknown"}`);
    summaryLines.push(`*Subject:* ${payload.subject ?? "Unknown"}`);
  }

  summaryLines.push(`*Notes:* ${receipt.notes ?? "None"}`);

  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "Receipt draft",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: summaryLines.join("\n"),
      },
    },
    {
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
    },
  ];
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
