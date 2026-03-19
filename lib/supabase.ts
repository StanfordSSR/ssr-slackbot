import { createClient } from "@supabase/supabase-js";
import { getEnv } from "@/lib/env";
import { GmailArtifactSource, LeadTeam, PendingReceiptPayload, ReceiptExtraction } from "@/types/receipt";

const supabase = createClient(getEnv("SUPABASE_URL")!, getEnv("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export type LeadProfile = {
  id: string;
  full_name: string | null;
  email: string | null;
};

export type GmailAccountLink = {
  id: string;
  team_id: string;
  linked_by_profile_id: string;
  gmail_email: string;
  google_subject_id: string;
  refresh_token_encrypted: string;
  access_token: string | null;
  access_token_expires_at: string | null;
  is_active: boolean;
  initial_backfill_completed_at: string | null;
  last_scan_started_at: string | null;
  last_scan_completed_at: string | null;
};

export type EmailReceiptIngestion = {
  id: string;
  gmail_link_id: string;
  gmail_message_id: string;
  gmail_thread_id: string | null;
  team_id: string;
  sender_email: string | null;
  subject: string | null;
  received_at: string | null;
  artifact_source: GmailArtifactSource;
  artifact_filename: string;
  artifact_mime_type: string;
  artifact_storage_path: string;
  extraction: ReceiptExtraction;
  status: "pending_approval" | "approved" | "rejected" | "duplicate" | "failed";
  slack_dm_message_refs:
    | Array<{ slack_user_id: string; channel: string; ts: string; selected_attachment_part_id?: string | null }>
    | null;
  approved_by: string | null;
  approved_at: string | null;
  error_text: string | null;
};

export async function findProfileByEmail(email: string) {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name, email")
    .ilike("email", email)
    .maybeSingle();

  if (error) throw error;
  return data as { id: string; full_name: string | null; email: string | null } | null;
}

export async function getLeadTeamsForUser(userId: string): Promise<LeadTeam[]> {
  const { data, error } = await supabase
    .from("team_memberships")
    .select("team_id, team_role, is_active, teams!inner(id, name, slug, is_active)")
    .eq("user_id", userId)
    .eq("is_active", true)
    .ilike("team_role", "lead");

  if (error) throw error;

  return (data ?? [])
    .map((row) => {
      const team = Array.isArray(row.teams) ? row.teams[0] : row.teams;
      if (!team || team.is_active === false) return null;
      return {
        id: team.id as string,
        name: team.name as string,
        slug: (team.slug as string | null) ?? null,
      } satisfies LeadTeam;
    })
    .filter((team): team is LeadTeam => Boolean(team));
}

export async function getLeadProfilesForTeam(teamId: string): Promise<LeadProfile[]> {
  const { data, error } = await supabase
    .from("team_memberships")
    .select("user_id, profiles!inner(id, full_name, email)")
    .eq("team_id", teamId)
    .eq("is_active", true)
    .ilike("team_role", "lead");

  if (error) throw error;

  return (data ?? [])
    .map((row) => {
      const profile = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles;
      if (!profile) return null;
      return {
        id: profile.id as string,
        full_name: (profile.full_name as string | null) ?? null,
        email: (profile.email as string | null) ?? null,
      } satisfies LeadProfile;
    })
    .filter((profile): profile is LeadProfile => Boolean(profile));
}

export async function getTeamById(teamId: string) {
  const { data, error } = await supabase.from("teams").select("id, name, slug").eq("id", teamId).maybeSingle();
  if (error) throw error;
  return data as { id: string; name: string; slug: string | null } | null;
}

export async function uploadReceiptToStorage(params: {
  teamId: string;
  purchaseId: string;
  fileBytes: ArrayBuffer;
  mimeType: string;
  filename: string;
}) {
  const extension = extensionFromFilename(params.filename, params.mimeType);
  const prefix = getEnv("SUPABASE_RECEIPT_PATH_PREFIX") || "slack-bot";
  const safeBaseName = sanitizeStorageFileName(params.filename.replace(/\.[^.]+$/, ""));
  const path = `${prefix}/${params.teamId}/${params.purchaseId}-${safeBaseName}.${extension}`;
  return uploadStorageArtifact({ path, fileBytes: params.fileBytes, mimeType: params.mimeType, filename: params.filename });
}

export async function createPurchaseLog(params: {
  purchaseId?: string;
  payload: PendingReceiptPayload;
  profileId: string;
  personName: string | null;
  receipt: {
    receipt_path: string | null;
    receipt_file_name: string | null;
    receipt_uploaded_at: string | null;
  };
}) {
  const purchaseId = params.purchaseId || crypto.randomUUID();
  const purchasedAt = normalizePurchasedAt(params.payload.extraction.purchase_date);
  const description =
    params.payload.extraction.item_name ||
    params.payload.extraction.merchant ||
    params.payload.filename ||
    "Slack receipt purchase";
  const amountCents = Math.round((params.payload.extraction.amount_total || 0) * 100);

  const insertPayload = {
    id: purchaseId,
    team_id: params.payload.teamId,
    created_by: params.profileId,
    academic_year: currentAcademicYear(),
    amount_cents: amountCents,
    description,
    purchased_at: purchasedAt,
    person_name: params.personName,
    payment_method: params.payload.extraction.payment_method,
    category: params.payload.extraction.category,
    receipt_path: params.receipt.receipt_path,
    receipt_file_name: params.receipt.receipt_file_name,
    receipt_uploaded_at: params.receipt.receipt_uploaded_at,
    receipt_not_needed: false,
  };

  const { error } = await supabase.from("purchase_logs").insert(insertPayload);
  if (error) throw error;

  return { purchaseId };
}

export async function uploadStorageArtifact(params: {
  path: string;
  fileBytes: ArrayBuffer;
  mimeType: string;
  filename: string;
}) {
  const bucket = getEnv("SUPABASE_RECEIPT_BUCKET");
  if (!bucket) {
    throw new Error("Missing required environment variable: SUPABASE_RECEIPT_BUCKET");
  }

  console.info("Uploading receipt to Supabase Storage", {
    bucket,
    path: params.path,
    mimeType: params.mimeType,
    filename: params.filename,
  });

  const { error } = await supabase.storage.from(bucket).upload(params.path, params.fileBytes, {
    contentType: params.mimeType,
    upsert: true,
  });

  if (error) throw error;

  console.info("Uploaded receipt to Supabase Storage", {
    bucket,
    path: params.path,
  });

  return {
    receipt_path: params.path,
    receipt_file_name: params.filename,
    receipt_uploaded_at: new Date().toISOString(),
  };
}

export async function upsertGmailAccountLink(params: {
  teamId: string;
  linkedByProfileId: string;
  gmailEmail: string;
  googleSubjectId: string;
  refreshTokenEncrypted: string;
  accessToken: string | null;
  accessTokenExpiresAt: string | null;
}) {
  const payload = {
    team_id: params.teamId,
    linked_by_profile_id: params.linkedByProfileId,
    gmail_email: params.gmailEmail,
    google_subject_id: params.googleSubjectId,
    refresh_token_encrypted: params.refreshTokenEncrypted,
    access_token: params.accessToken,
    access_token_expires_at: params.accessTokenExpiresAt,
    is_active: true,
  };

  const { data: existing, error: existingError } = await supabase
    .from("gmail_account_links")
    .select("id")
    .eq("team_id", params.teamId)
    .ilike("gmail_email", params.gmailEmail)
    .eq("is_active", true)
    .maybeSingle();

  if (existingError) throw existingError;

  if (existing?.id) {
    const { data, error } = await supabase
      .from("gmail_account_links")
      .update(payload)
      .eq("id", existing.id)
      .select(
        "id, team_id, linked_by_profile_id, gmail_email, google_subject_id, refresh_token_encrypted, access_token, access_token_expires_at, is_active, initial_backfill_completed_at, last_scan_started_at, last_scan_completed_at",
      )
      .single();

    if (error) throw error;
    return data as GmailAccountLink;
  }

  const { data, error } = await supabase
    .from("gmail_account_links")
    .insert(payload)
    .select(
      "id, team_id, linked_by_profile_id, gmail_email, google_subject_id, refresh_token_encrypted, access_token, access_token_expires_at, is_active, initial_backfill_completed_at, last_scan_started_at, last_scan_completed_at",
    )
    .single();

  if (error) throw error;
  return data as GmailAccountLink;
}

export async function getActiveGmailAccountLinks(): Promise<GmailAccountLink[]> {
  const { data, error } = await supabase
    .from("gmail_account_links")
    .select(
      "id, team_id, linked_by_profile_id, gmail_email, google_subject_id, refresh_token_encrypted, access_token, access_token_expires_at, is_active, initial_backfill_completed_at, last_scan_started_at, last_scan_completed_at",
    )
    .eq("is_active", true);

  if (error) throw error;
  return (data ?? []) as GmailAccountLink[];
}

export async function getActiveGmailAccountLinksForProfile(profileId: string): Promise<GmailAccountLink[]> {
  const { data, error } = await supabase
    .from("gmail_account_links")
    .select(
      "id, team_id, linked_by_profile_id, gmail_email, google_subject_id, refresh_token_encrypted, access_token, access_token_expires_at, is_active, initial_backfill_completed_at, last_scan_started_at, last_scan_completed_at",
    )
    .eq("linked_by_profile_id", profileId)
    .eq("is_active", true);

  if (error) throw error;
  return (data ?? []) as GmailAccountLink[];
}

export async function getGmailAccountLinkById(linkId: string) {
  const { data, error } = await supabase
    .from("gmail_account_links")
    .select(
      "id, team_id, linked_by_profile_id, gmail_email, google_subject_id, refresh_token_encrypted, access_token, access_token_expires_at, is_active, initial_backfill_completed_at, last_scan_started_at, last_scan_completed_at",
    )
    .eq("id", linkId)
    .maybeSingle();

  if (error) throw error;
  return data as GmailAccountLink | null;
}

export async function updateGmailAccountLinkTokens(params: {
  linkId: string;
  accessToken: string | null;
  accessTokenExpiresAt: string | null;
  refreshTokenEncrypted?: string;
}) {
  const updatePayload: Record<string, string | null> = {
    access_token: params.accessToken,
    access_token_expires_at: params.accessTokenExpiresAt,
  };
  if (params.refreshTokenEncrypted) {
    updatePayload.refresh_token_encrypted = params.refreshTokenEncrypted;
  }

  const { error } = await supabase.from("gmail_account_links").update(updatePayload).eq("id", params.linkId);
  if (error) throw error;
}

export async function markGmailScanStarted(linkId: string) {
  const { error } = await supabase
    .from("gmail_account_links")
    .update({ last_scan_started_at: new Date().toISOString() })
    .eq("id", linkId);
  if (error) throw error;
}

export async function markGmailScanCompleted(linkId: string, initialBackfillCompleted: boolean) {
  const payload: Record<string, string> = {
    last_scan_completed_at: new Date().toISOString(),
  };
  if (initialBackfillCompleted) {
    payload.initial_backfill_completed_at = new Date().toISOString();
  }
  const { error } = await supabase.from("gmail_account_links").update(payload).eq("id", linkId);
  if (error) throw error;
}

export async function disableGmailAccountLink(linkId: string) {
  const { error } = await supabase.from("gmail_account_links").update({ is_active: false }).eq("id", linkId);
  if (error) throw error;
}

export async function hasEmailReceiptIngestion(params: { gmailLinkId: string; gmailMessageId: string }) {
  const { data, error } = await supabase
    .from("email_receipt_ingestions")
    .select("id, status")
    .eq("gmail_link_id", params.gmailLinkId)
    .eq("gmail_message_id", params.gmailMessageId)
    .maybeSingle();

  if (error) throw error;
  return (data as { id: string; status: EmailReceiptIngestion["status"] } | null) ?? null;
}

export async function deleteEmailReceiptIngestion(ingestionId: string) {
  const { error } = await supabase.from("email_receipt_ingestions").delete().eq("id", ingestionId);
  if (error) throw error;
}

export async function createEmailReceiptIngestion(params: {
  gmailLinkId: string;
  gmailMessageId: string;
  gmailThreadId: string | null;
  teamId: string;
  senderEmail: string | null;
  subject: string | null;
  receivedAt: string | null;
  artifactSource: GmailArtifactSource;
  artifactFilename: string;
  artifactMimeType: string;
  artifactStoragePath: string;
  extraction: ReceiptExtraction;
}) {
  const payload = {
    gmail_link_id: params.gmailLinkId,
    gmail_message_id: params.gmailMessageId,
    gmail_thread_id: params.gmailThreadId,
    team_id: params.teamId,
    sender_email: params.senderEmail,
    subject: params.subject,
    received_at: params.receivedAt,
    artifact_source: params.artifactSource,
    artifact_filename: params.artifactFilename,
    artifact_mime_type: params.artifactMimeType,
    artifact_storage_path: params.artifactStoragePath,
    extraction: params.extraction,
    status: "pending_approval",
  };

  const { data, error } = await supabase
    .from("email_receipt_ingestions")
    .insert(payload)
    .select(
      "id, gmail_link_id, gmail_message_id, gmail_thread_id, team_id, sender_email, subject, received_at, artifact_source, artifact_filename, artifact_mime_type, artifact_storage_path, extraction, status, slack_dm_message_refs, approved_by, approved_at, error_text",
    )
    .single();

  if (error) throw error;
  return data as EmailReceiptIngestion;
}

export async function updateEmailReceiptIngestionMessages(
  ingestionId: string,
  refs: Array<{ slack_user_id: string; channel: string; ts: string; selected_attachment_part_id?: string | null }>,
) {
  const { error } = await supabase
    .from("email_receipt_ingestions")
    .update({ slack_dm_message_refs: refs })
    .eq("id", ingestionId);
  if (error) throw error;
}

export async function updateEmailReceiptIngestionSelection(params: {
  ingestionId: string;
  slackUserId: string;
  channel: string;
  attachmentPartId: string;
}) {
  const current = await getEmailReceiptIngestionById(params.ingestionId);
  if (!current) return;

  const refs = (current.slack_dm_message_refs ?? []).map((ref) =>
    ref.slack_user_id === params.slackUserId && ref.channel === params.channel
      ? { ...ref, selected_attachment_part_id: params.attachmentPartId }
      : ref,
  );

  const { error } = await supabase
    .from("email_receipt_ingestions")
    .update({ slack_dm_message_refs: refs })
    .eq("id", params.ingestionId)
    .eq("status", "pending_approval");

  if (error) throw error;
}

export async function markEmailReceiptIngestionFailed(ingestionId: string, errorText: string) {
  const { error } = await supabase
    .from("email_receipt_ingestions")
    .update({ status: "failed", error_text: errorText })
    .eq("id", ingestionId);
  if (error) throw error;
}

export async function updateEmailReceiptIngestionDraft(params: {
  ingestionId: string;
  artifactSource: GmailArtifactSource;
  artifactFilename: string;
  artifactMimeType: string;
  artifactStoragePath: string;
  extraction: ReceiptExtraction;
}) {
  const { error } = await supabase
    .from("email_receipt_ingestions")
    .update({
      artifact_source: params.artifactSource,
      artifact_filename: params.artifactFilename,
      artifact_mime_type: params.artifactMimeType,
      artifact_storage_path: params.artifactStoragePath,
      extraction: params.extraction,
      error_text: null,
    })
    .eq("id", params.ingestionId)
    .eq("status", "pending_approval");

  if (error) throw error;
}

export async function getEmailReceiptIngestionById(ingestionId: string) {
  const { data, error } = await supabase
    .from("email_receipt_ingestions")
    .select(
      "id, gmail_link_id, gmail_message_id, gmail_thread_id, team_id, sender_email, subject, received_at, artifact_source, artifact_filename, artifact_mime_type, artifact_storage_path, extraction, status, slack_dm_message_refs, approved_by, approved_at, error_text, teams(name)",
    )
    .eq("id", ingestionId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const team = Array.isArray(data.teams) ? data.teams[0] : data.teams;
  return {
    ...(data as unknown as EmailReceiptIngestion),
    teamName: (team?.name as string | undefined) || "Unknown team",
  };
}

export async function approveEmailReceiptIngestion(params: { ingestionId: string; approverProfileId: string }) {
  const approvedAt = new Date().toISOString();
  const { data, error } = await supabase
    .from("email_receipt_ingestions")
    .update({
      status: "approved",
      approved_by: params.approverProfileId,
      approved_at: approvedAt,
    })
    .eq("id", params.ingestionId)
    .eq("status", "pending_approval")
    .select(
      "id, gmail_link_id, gmail_message_id, gmail_thread_id, team_id, sender_email, subject, received_at, artifact_source, artifact_filename, artifact_mime_type, artifact_storage_path, extraction, status, slack_dm_message_refs, approved_by, approved_at, error_text, teams(name)",
    )
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  const team = Array.isArray(data.teams) ? data.teams[0] : data.teams;
  return {
    ...(data as unknown as EmailReceiptIngestion),
    teamName: (team?.name as string | undefined) || "Unknown team",
  };
}

export async function rejectEmailReceiptIngestion(params: { ingestionId: string; approverProfileId: string }) {
  const { data, error } = await supabase
    .from("email_receipt_ingestions")
    .update({
      status: "rejected",
      approved_by: params.approverProfileId,
      approved_at: new Date().toISOString(),
    })
    .eq("id", params.ingestionId)
    .eq("status", "pending_approval")
    .select("id")
    .maybeSingle();

  if (error) throw error;
  return Boolean(data);
}

export async function recordEmailReceiptApproval(params: {
  ingestionId: string;
  leadProfileId: string;
  slackUserId: string;
  decision: "approved" | "rejected";
}) {
  const { error } = await supabase.from("email_receipt_approvals").upsert(
    {
      ingestion_id: params.ingestionId,
      lead_profile_id: params.leadProfileId,
      slack_user_id: params.slackUserId,
      decision: params.decision,
    },
    { onConflict: "ingestion_id,lead_profile_id" },
  );

  if (error) throw error;
}

function extensionFromFilename(filename: string, mimeType: string) {
  const clean = filename.toLowerCase();
  if (clean.endsWith(".pdf")) return "pdf";
  if (clean.endsWith(".png")) return "png";
  if (clean.endsWith(".webp")) return "webp";
  if (clean.endsWith(".jpg") || clean.endsWith(".jpeg")) return "jpg";
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  return "jpg";
}

function sanitizeStorageFileName(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "receipt";
}

function normalizePurchasedAt(date: string | null) {
  if (!date) return new Date().toISOString();
  return `${date}T12:00:00.000Z`;
}

function currentAcademicYear() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const startYear = month >= 9 ? year : year - 1;
  const endYearShort = String((startYear + 1) % 100).padStart(2, "0");
  return `${startYear}-${endYearShort}`;
}
