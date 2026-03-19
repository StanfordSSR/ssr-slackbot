import { createClient } from "@supabase/supabase-js";
import { getEnv } from "@/lib/env";

const supabase = createClient(getEnv("SUPABASE_URL")!, getEnv("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export async function recordAuditEvent(params: {
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  summary: string;
  details?: Record<string, unknown>;
}) {
  const { error } = await supabase.from("audit_log_entries").insert({
    actor_id: params.actorId,
    action: params.action,
    target_type: params.targetType,
    target_id: params.targetId,
    summary: params.summary,
    details: params.details ?? {},
  });

  if (error) throw error;
}
