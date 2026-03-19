import { LeadTeam, PendingReceiptPayload, ReceiptExtraction } from "@/types/receipt";
import { encodeActionValue, prettyCurrency } from "@/lib/receipt-utils";

export function receiptReviewBlocks(params: { teamName: string; payload: PendingReceiptPayload }) {
  const { teamName, payload } = params;
  const receipt = payload.extraction;

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
      fields: [
        { type: "mrkdwn", text: `*Team*\n${teamName}` },
        { type: "mrkdwn", text: `*Merchant*\n${receipt.merchant ?? "Unknown"}` },
        { type: "mrkdwn", text: `*Amount*\n${prettyCurrency(receipt.amount_total, receipt.currency)}` },
        { type: "mrkdwn", text: `*Date*\n${receipt.purchase_date ?? "Unknown"}` },
        { type: "mrkdwn", text: `*Item*\n${receipt.item_name ?? "Unknown"}` },
        { type: "mrkdwn", text: `*Category*\n${receipt.category}` },
        { type: "mrkdwn", text: `*Payment*\n${receipt.payment_method}` },
        { type: "mrkdwn", text: `*Confidence*\n${Math.round(receipt.confidence * 100)}%` },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Notes*\n${receipt.notes ?? "None"}`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Confirm" },
          style: "primary",
          action_id: "confirm_receipt",
          value: encodeActionValue(payload),
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Cancel" },
          style: "danger",
          action_id: "cancel_receipt",
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
