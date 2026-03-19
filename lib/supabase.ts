import { createClient } from "@supabase/supabase-js";
import { getEnv } from "@/lib/env";
import { LeadTeam, PendingReceiptPayload } from "@/types/receipt";

const supabase = createClient(getEnv("SUPABASE_URL")!, getEnv("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

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

export async function uploadReceiptToStorage(params: {
  teamId: string;
  purchaseId: string;
  fileBytes: ArrayBuffer;
  mimeType: string;
  filename: string;
}) {
  const bucket = getEnv("SUPABASE_RECEIPT_BUCKET");
  if (!bucket) {
    throw new Error("Missing required environment variable: SUPABASE_RECEIPT_BUCKET");
  }

  const extension = extensionFromFilename(params.filename, params.mimeType);
  const prefix = getEnv("SUPABASE_RECEIPT_PATH_PREFIX") || "slack-bot";
  const safeBaseName = sanitizeStorageFileName(params.filename.replace(/\.[^.]+$/, ""));
  const path = `${prefix}/${params.teamId}/${params.purchaseId}-${safeBaseName}.${extension}`;

  console.info("Uploading receipt to Supabase Storage", {
    bucket,
    path,
    mimeType: params.mimeType,
    filename: params.filename,
  });

  const { error } = await supabase.storage.from(bucket).upload(path, params.fileBytes, {
    contentType: params.mimeType,
    upsert: true,
  });

  if (error) throw error;

  console.info("Uploaded receipt to Supabase Storage", {
    bucket,
    path,
  });

  return {
    receipt_path: path,
    receipt_file_name: params.filename,
    receipt_uploaded_at: new Date().toISOString(),
  };
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
  return month >= 9 ? `${year}-${year + 1}` : `${year - 1}-${year}`;
}
