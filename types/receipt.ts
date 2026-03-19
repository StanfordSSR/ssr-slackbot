export type PurchaseCategory = "equipment" | "food" | "travel";

export type PaymentMethod = "reimbursement" | "credit_card" | "amazon" | "unknown";

export type ReceiptExtraction = {
  merchant: string | null;
  purchase_date: string | null;
  amount_total: number | null;
  currency: string | null;
  item_name: string | null;
  category: PurchaseCategory;
  payment_method: PaymentMethod;
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

export type ReceiptSource = "slack" | "gmail";

export type SlackPendingReceiptPayload = {
  source: "slack";
  teamId: string;
  teamName: string;
  fileId: string;
  filename: string;
  mimeType: string;
  extraction: ReceiptExtraction;
};

export type GmailArtifactSource = "attachment" | "email_pdf";

export type GmailPendingReceiptPayload = {
  source: "gmail";
  ingestionId: string;
  teamId: string;
  teamName: string;
  filename: string;
  mimeType: string;
  artifactSource: GmailArtifactSource;
  senderEmail: string | null;
  subject: string | null;
  extraction: ReceiptExtraction;
};

export type PendingReceiptPayload = SlackPendingReceiptPayload | GmailPendingReceiptPayload;
