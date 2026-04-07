import { GmailAttachmentChoicePayload, LeadTeam, ReceiptPendingPayload, ReceiptExtraction } from "@/types/receipt";
import { encodeActionValue, encodeAmazonClaimValue, encodeAttachmentSelectValue, isGmailPendingReceiptPayload, prettyCurrency } from "@/lib/receipt-utils";

export type EventRsvpPayload = {
  source: "event_rsvp";
  announcementId: string;
  recipientEmail: string;
  response: "yes" | "maybe" | "no";
  callbackUrl: string;
  title: string;
  eventAt: string | null;
  location: string | null;
};

export function receiptReviewBlocks(params: { teamName: string; payload: ReceiptPendingPayload }) {
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

export function receiptDecisionBlocks(params: {
  status: "confirmed" | "rejected" | "canceled";
  title: string;
  detail?: string;
}) {
  const label =
    params.status === "confirmed" ? "Confirmed" : params.status === "rejected" ? "Rejected" : "Canceled";

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${params.title}*\n${label}${params.detail ? `\n${params.detail}` : ""}`,
      },
    },
  ];
}

export function amazonClaimBlocks(params: {
  ingestionId: string;
  itemName: string;
  amountTotal: number;
  currency: string | null;
  purchaseDate: string | null;
  teams: LeadTeam[];
}) {
  const safeTeams = params.teams
    .filter((team) => team.id && team.name?.trim())
    .map((team) => ({
      id: team.id,
      name: team.name.trim().slice(0, 40),
    }));
  const teamRows = chunk(safeTeams, 5);
  const safeItemName = params.itemName.replace(/\s+/g, " ").trim().slice(0, 120) || "Amazon order";
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Amazon Purchase Claim*",
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Automated from the linked Amazon inbox. Please claim this purchase for the correct team.",
        },
      ],
    },
    {
      type: "divider",
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Item*\n${safeItemName}` },
        { type: "mrkdwn", text: `*Total*\n${prettyCurrency(params.amountTotal, params.currency)}` },
        { type: "mrkdwn", text: `*Date*\n${params.purchaseDate || "Unknown"}` },
      ],
    },
    ...teamRows.map((teams) => ({
      type: "actions",
      elements: teams.map((team) => ({
        type: "button",
        text: { type: "plain_text", text: team.name },
        action_id: `claim_amazon_order_${team.id.slice(0, 16)}`,
        value: encodeAmazonClaimValue(params.ingestionId, team.id),
      })),
    })),
  ];
}

export function amazonClaimDecisionBlocks(params: {
  teamName: string;
  itemName: string;
  amountTotal: number;
  currency: string | null;
}) {
  const safeItemName = params.itemName.replace(/\s+/g, " ").trim().slice(0, 120) || "Amazon order";
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Amazon Purchase Claim*\n${safeItemName} - ${prettyCurrency(params.amountTotal, params.currency)}\nClaimed by ${params.teamName}`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Claim completed",
        },
      ],
    },
  ];
}

export function eventAnnouncementBlocks(params: {
  title: string;
  eventAt: string | null;
  location: string | null;
  details: string;
  recipientEmail: string;
  announcementId: string;
  callbackUrl: string;
}) {
  const fields = [
    {
      type: "mrkdwn",
      text: `*Date & time*\n${formatEventDateTime(params.eventAt)}`,
    },
    {
      type: "mrkdwn",
      text: `*Location*\n${params.location?.trim() || "TBD"}`,
    },
  ];

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${params.title}*`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Event announcement from SSR HQ",
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
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Details*\n${params.details || "No additional details."}`,
      },
    },
    {
      type: "actions",
      elements: [
        buildEventRsvpButton("Yes", "primary", {
          source: "event_rsvp",
          announcementId: params.announcementId,
          recipientEmail: params.recipientEmail,
          response: "yes",
          callbackUrl: params.callbackUrl,
          title: params.title,
          eventAt: params.eventAt,
          location: params.location,
        }),
        buildEventRsvpButton("Maybe", undefined, {
          source: "event_rsvp",
          announcementId: params.announcementId,
          recipientEmail: params.recipientEmail,
          response: "maybe",
          callbackUrl: params.callbackUrl,
          title: params.title,
          eventAt: params.eventAt,
          location: params.location,
        }),
        buildEventRsvpButton("No", "danger", {
          source: "event_rsvp",
          announcementId: params.announcementId,
          recipientEmail: params.recipientEmail,
          response: "no",
          callbackUrl: params.callbackUrl,
          title: params.title,
          eventAt: params.eventAt,
          location: params.location,
        }),
      ],
    },
  ];
}

export function eventAnnouncementDecisionBlocks(params: {
  title: string;
  eventAt: string | null;
  location: string | null;
  response: "yes" | "maybe" | "no";
  counts?: { yes?: number; maybe?: number; no?: number } | null;
}) {
  const responseLabel = params.response === "yes" ? "Yes" : params.response === "maybe" ? "Maybe" : "No";
  const countsText = params.counts
    ? `\nYes ${params.counts.yes ?? 0} • Maybe ${params.counts.maybe ?? 0} • No ${params.counts.no ?? 0}`
    : "";

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${params.title}*\n*Date & time:* ${formatEventDateTime(params.eventAt)}\n*Location:* ${params.location?.trim() || "TBD"}`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `RSVP recorded: *${responseLabel}*${countsText}`,
        },
      ],
    },
  ];
}

function buildEventRsvpButton(
  label: "Yes" | "Maybe" | "No",
  style: "primary" | "danger" | undefined,
  payload: EventRsvpPayload,
) {
  return {
    type: "button",
    text: { type: "plain_text", text: label },
    style,
    action_id: `event_rsvp_${payload.response}`,
    value: Buffer.from(JSON.stringify(payload), "utf8").toString("base64url"),
  };
}

function formatEventDateTime(eventAt: string | null) {
  if (!eventAt) return "TBD";
  const date = new Date(eventAt);
  if (Number.isNaN(date.getTime())) return eventAt;

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Los_Angeles",
  }).format(date);
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

function chunk<T>(input: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < input.length; index += size) {
    chunks.push(input.slice(index, index + size));
  }
  return chunks;
}
