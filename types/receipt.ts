export type ReceiptExtraction = {
  merchant: string | null;
  purchase_date: string | null;
  amount_total: number | null;
  currency: string | null;
  item_name: string | null;
  confidence: number;
  notes: string | null;
};

export type SlackUserIdentity = {
  slackUserId: string;
  email: string;
  displayName: string | null;
  realName: string | null;
};

export type LeadTeam = {
  id: string;
  name: string;
  slug: string | null;
};

export type PendingReceiptPayload = {
  teamId: string;
  teamName: string;
  fileId: string;
  filename: string;
  mimeType: string;
  extraction: ReceiptExtraction;
};
