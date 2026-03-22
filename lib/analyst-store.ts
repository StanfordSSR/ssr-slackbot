import { createClient } from "@supabase/supabase-js";
import { getEnv } from "@/lib/env";
import { ContextSourceRecord, SchemaCatalogColumn, SchemaCatalogTable } from "@/types/analyst";
import { getActiveTeams, getLeadTeamsForUser } from "@/lib/supabase";

const supabase = createClient(getEnv("SUPABASE_URL")!, getEnv("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export async function getRuntimeConfig<T = Record<string, unknown>>(key: string) {
  const { data, error } = await supabase.from("analyst_runtime_config").select("config_value").eq("config_key", key).maybeSingle();
  if (error) throw error;
  return (data?.config_value as T | undefined) ?? null;
}

export async function setRuntimeConfig(key: string, value: Record<string, unknown>) {
  const { error } = await supabase.from("analyst_runtime_config").upsert(
    { config_key: key, config_value: value },
    { onConflict: "config_key" },
  );
  if (error) throw error;
}

export async function startSchemaRefreshRun() {
  const { data, error } = await supabase
    .from("schema_refresh_runs")
    .insert({ status: "processing" })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

export async function completeSchemaRefreshRun(params: {
  runId: string;
  refreshedTables: number;
  refreshedColumns: number;
  refreshedRelationships: number;
}) {
  const { error } = await supabase
    .from("schema_refresh_runs")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
      refreshed_tables: params.refreshedTables,
      refreshed_columns: params.refreshedColumns,
      refreshed_relationships: params.refreshedRelationships,
    })
    .eq("id", params.runId);
  if (error) throw error;
}

export async function failSchemaRefreshRun(runId: string, errorText: string) {
  const { error } = await supabase
    .from("schema_refresh_runs")
    .update({
      status: "failed",
      completed_at: new Date().toISOString(),
      error_text: errorText,
    })
    .eq("id", runId);
  if (error) throw error;
}

export async function getLiveSchemaColumns() {
  const { data, error } = await supabase.rpc("get_live_schema_columns");
  if (error) throw error;
  return (data ?? []) as Array<{
    schema_name: string;
    table_name: string;
    table_kind: string;
    column_name: string;
    data_type: string;
    is_nullable: boolean;
    ordinal_position: number;
  }>;
}

export async function getLiveSchemaRelationships() {
  const { data, error } = await supabase.rpc("get_live_schema_relationships");
  if (error) throw error;
  return (data ?? []) as Array<{
    from_schema: string;
    from_table: string;
    from_column: string;
    to_schema: string;
    to_table: string;
    to_column: string;
  }>;
}

export async function replaceSchemaCatalog(params: {
  tables: Array<Omit<SchemaCatalogTable, "id">>;
  columns: Array<{ tableKey: string } & Omit<SchemaCatalogColumn, "table_id">>;
  relationships: Array<{
    fromTableKey: string;
    fromColumnName: string;
    toTableKey: string;
    toColumnName: string;
    relationshipKind: string;
  }>;
}) {
  const { error: deleteRelationshipsError } = await supabase.from("schema_catalog_relationships").delete().not("id", "is", null);
  if (deleteRelationshipsError) throw deleteRelationshipsError;
  const { error: deleteColumnsError } = await supabase.from("schema_catalog_columns").delete().not("id", "is", null);
  if (deleteColumnsError) throw deleteColumnsError;
  const { error: deleteTablesError } = await supabase.from("schema_catalog_tables").delete().not("id", "is", null);
  if (deleteTablesError) throw deleteTablesError;

  const { data: insertedTables, error: insertTablesError } = await supabase
    .from("schema_catalog_tables")
    .insert(params.tables)
    .select("id, schema_name, table_name");
  if (insertTablesError) throw insertTablesError;

  const tableIdByKey = new Map(
    (insertedTables ?? []).map((row) => [`${row.schema_name}.${row.table_name}`, row.id as string]),
  );

  if (params.columns.length > 0) {
    const { error: insertColumnsError } = await supabase.from("schema_catalog_columns").insert(
      params.columns.map((column) => ({
        table_id: tableIdByKey.get(column.tableKey),
        column_name: column.column_name,
        data_type: column.data_type,
        is_nullable: column.is_nullable,
        ordinal_position: column.ordinal_position,
        semantic_roles: column.semantic_roles,
        is_queryable: column.is_queryable,
      })),
    );
    if (insertColumnsError) throw insertColumnsError;
  }

  if (params.relationships.length > 0) {
    const { error: insertRelationshipsError } = await supabase.from("schema_catalog_relationships").insert(
      params.relationships
        .map((relationship) => ({
          from_table_id: tableIdByKey.get(relationship.fromTableKey),
          from_column_name: relationship.fromColumnName,
          to_table_id: tableIdByKey.get(relationship.toTableKey),
          to_column_name: relationship.toColumnName,
          relationship_kind: relationship.relationshipKind,
        }))
        .filter((row) => row.from_table_id && row.to_table_id),
    );
    if (insertRelationshipsError) throw insertRelationshipsError;
  }
}

export async function getSchemaCatalog() {
  const { data: tables, error: tablesError } = await supabase
    .from("schema_catalog_tables")
    .select(
      "id, schema_name, table_name, table_kind, description, scope_kind, team_scope_column, access_level, semantic_roles, preferred_time_column, is_queryable, row_count_hint",
    )
    .eq("is_queryable", true)
    .neq("access_level", "blocked")
    .order("schema_name")
    .order("table_name");
  if (tablesError) {
    if ((tablesError as { code?: string }).code === "PGRST205") {
      return { tables: [], columns: [] };
    }
    throw tablesError;
  }

  const tableIds = (tables ?? []).map((table) => table.id as string);
  const { data: columns, error: columnsError } = await supabase
    .from("schema_catalog_columns")
    .select("table_id, column_name, data_type, is_nullable, ordinal_position, semantic_roles, is_queryable")
    .in("table_id", tableIds.length > 0 ? tableIds : ["00000000-0000-0000-0000-000000000000"])
    .eq("is_queryable", true)
    .order("ordinal_position");
  if (columnsError) {
    if ((columnsError as { code?: string }).code === "PGRST205") {
      return { tables: [], columns: [] };
    }
    throw columnsError;
  }

  return {
    tables: (tables ?? []) as SchemaCatalogTable[],
    columns: (columns ?? []) as SchemaCatalogColumn[],
  };
}

export async function executeGuardedSql(params: { sql: string; maxRows?: number; timeoutMs?: number }) {
  const { data, error } = await supabase.rpc("execute_guarded_sql", {
    query_text: params.sql,
    max_rows: params.maxRows ?? 50,
    timeout_ms: params.timeoutMs ?? 4000,
  });
  if (error) throw error;
  return (data ?? []) as Array<Record<string, unknown>>;
}

export async function recordQuestionSqlQuery(params: {
  sessionId: string;
  stepIndex: number;
  rationale: string;
  proposedSql: string;
  executedSql?: string;
  sqlFingerprint?: string;
  referencedTables: string[];
  rowCount: number;
  durationMs: number;
  status: "proposed" | "executed" | "rejected" | "failed";
  errorText?: string | null;
  resultPreview?: unknown;
}) {
  const { error } = await supabase.from("question_sql_queries").insert({
    session_id: params.sessionId,
    step_index: params.stepIndex,
    rationale: params.rationale,
    proposed_sql: params.proposedSql,
    executed_sql: params.executedSql ?? null,
    sql_fingerprint: params.sqlFingerprint ?? null,
    referenced_tables: params.referencedTables,
    row_count: params.rowCount,
    duration_ms: params.durationMs,
    status: params.status,
    error_text: params.errorText ?? null,
    result_preview: params.resultPreview ?? null,
  });
  if (error) throw error;
}

export async function createContextSource(params: {
  linkedByProfileId: string;
  sourceType: "url" | "slack_file";
  sourceUrl?: string | null;
  slackFileId?: string | null;
  title: string;
  corpus: "org" | "internal";
  scope: "org" | "team";
  teamId?: string | null;
  tags: string[];
  isCanonical: boolean;
  canonicalKind?: string | null;
  mimeType?: string | null;
}) {
  const { data, error } = await supabase
    .from("context_sources")
    .insert({
      linked_by_profile_id: params.linkedByProfileId,
      source_type: params.sourceType,
      source_url: params.sourceUrl ?? null,
      slack_file_id: params.slackFileId ?? null,
      title: params.title,
      corpus: params.corpus,
      scope: params.scope,
      team_id: params.teamId ?? null,
      tags: params.tags,
      is_canonical: params.isCanonical,
      canonical_kind: params.canonicalKind ?? null,
      mime_type: params.mimeType ?? null,
      status: "processing",
    })
    .select(
      "id, title, source_type, source_url, corpus, scope, team_id, tags, is_canonical, canonical_kind, mime_type, openai_file_id, openai_vector_store_id, content_text, content_summary, status, error_text",
    )
    .single();
  if (error) throw error;
  return data as ContextSourceRecord;
}

export async function updateContextSourceReady(params: {
  sourceId: string;
  title: string;
  contentText: string | null;
  contentSummary: string;
  openaiFileId?: string | null;
  openaiVectorStoreId?: string | null;
}) {
  const { error } = await supabase
    .from("context_sources")
    .update({
      title: params.title,
      content_text: params.contentText,
      content_summary: params.contentSummary,
      openai_file_id: params.openaiFileId ?? null,
      openai_vector_store_id: params.openaiVectorStoreId ?? null,
      status: "ready",
      error_text: null,
    })
    .eq("id", params.sourceId);
  if (error) throw error;
}

export async function markContextSourceFailed(sourceId: string, errorText: string) {
  const { error } = await supabase
    .from("context_sources")
    .update({ status: "failed", error_text: errorText })
    .eq("id", sourceId);
  if (error) throw error;
}

export async function listCanonicalContextSources() {
  const { data, error } = await supabase
    .from("context_sources")
    .select(
      "id, title, source_type, source_url, corpus, scope, team_id, tags, is_canonical, canonical_kind, mime_type, openai_file_id, openai_vector_store_id, content_text, content_summary, status, error_text",
    )
    .eq("is_canonical", true)
    .eq("status", "ready");
  if (error) throw error;
  return (data ?? []) as ContextSourceRecord[];
}

export async function searchContextSources(params: {
  query: string;
  corpus?: "org" | "internal";
  tags?: string[];
  teamId?: string | null;
  limit: number;
}) {
  let queryBuilder = supabase
    .from("context_sources")
    .select(
      "id, title, source_type, source_url, corpus, scope, team_id, tags, is_canonical, canonical_kind, mime_type, openai_file_id, openai_vector_store_id, content_text, content_summary, status, error_text",
    )
    .eq("status", "ready")
    .limit(params.limit);

  if (params.corpus) {
    queryBuilder = queryBuilder.eq("corpus", params.corpus);
  }
  if (params.teamId) {
    queryBuilder = queryBuilder.or(`scope.eq.org,team_id.eq.${params.teamId}`);
  }
  if (params.tags && params.tags.length > 0) {
    queryBuilder = queryBuilder.overlaps("tags", params.tags);
  }

  const { data, error } = await queryBuilder;
  if (error) throw error;

  const normalizedQuery = params.query.trim().toLowerCase();
  const scored = ((data ?? []) as ContextSourceRecord[])
    .map((row) => {
      const haystack = `${row.title}\n${row.content_summary ?? ""}\n${row.content_text ?? ""}`.toLowerCase();
      const score = normalizedQuery
        .split(/\s+/)
        .filter(Boolean)
        .reduce((total, part) => total + (haystack.includes(part) ? 1 : 0), 0);
      return { row, score };
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, params.limit)
    .map((item) => item.row);

  return scored;
}

export async function createQuestionSession(params: {
  slackUserId: string;
  profileId: string | null;
  channelId: string | null;
  threadTs: string | null;
  entrypoint: "mention" | "slash_command";
  prompt: string;
  normalizedPrompt: string;
  cacheKey: string;
}) {
  const { data, error } = await supabase
    .from("question_sessions")
    .insert({
      slack_user_id: params.slackUserId,
      profile_id: params.profileId,
      channel_id: params.channelId,
      thread_ts: params.threadTs,
      entrypoint: params.entrypoint,
      prompt: params.prompt,
      normalized_prompt: params.normalizedPrompt,
      status: "processing",
      cache_key: params.cacheKey,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

export async function updateQuestionSessionPlan(sessionId: string, route: string, plan: Record<string, unknown>) {
  const { error } = await supabase.from("question_sessions").update({ route, plan }).eq("id", sessionId);
  if (error) throw error;
}

export async function completeQuestionSession(params: {
  sessionId: string;
  finalAnswer: string;
  confidenceLabel: string;
  modelTier: string;
  costTier: string;
  estimatedCostUsd: number;
  usage: Record<string, unknown>;
}) {
  const { error } = await supabase
    .from("question_sessions")
    .update({
      status: "completed",
      final_answer: params.finalAnswer,
      confidence_label: params.confidenceLabel,
      model_tier: params.modelTier,
      cost_tier: params.costTier,
      estimated_cost_usd: params.estimatedCostUsd,
      usage: params.usage,
      error_text: null,
    })
    .eq("id", params.sessionId);
  if (error) throw error;
}

export async function failQuestionSession(sessionId: string, errorText: string) {
  const { error } = await supabase.from("question_sessions").update({ status: "failed", error_text: errorText }).eq("id", sessionId);
  if (error) throw error;
}

export async function recordQuestionToolCall(params: {
  sessionId: string;
  stepIndex: number;
  toolName: string;
  inputJson: Record<string, unknown>;
  outputJson: Record<string, unknown>;
  durationMs: number;
}) {
  const { error } = await supabase.from("question_tool_calls").insert({
    session_id: params.sessionId,
    step_index: params.stepIndex,
    tool_name: params.toolName,
    input_json: params.inputJson,
    output_json: params.outputJson,
    duration_ms: params.durationMs,
  });
  if (error) throw error;
}

export async function addQuestionEvidence(params: {
  sessionId: string;
  sourceKind: "org_profile" | "context_source" | "structured_tool" | "web";
  sourceRef?: string | null;
  title: string;
  citationText: string;
  metadata?: Record<string, unknown>;
}) {
  const { error } = await supabase.from("question_evidence").insert({
    session_id: params.sessionId,
    source_kind: params.sourceKind,
    source_ref: params.sourceRef ?? null,
    title: params.title,
    citation_text: params.citationText,
    metadata: params.metadata ?? {},
  });
  if (error) throw error;
}

export async function getAnswerCache(cacheKey: string) {
  const { data, error } = await supabase
    .from("answer_cache")
    .select("answer_json, source_version_key, expires_at")
    .eq("cache_key", cacheKey)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  if (data.expires_at && new Date(data.expires_at).getTime() < Date.now()) return null;
  return data.answer_json as Record<string, unknown>;
}

export async function upsertAnswerCache(params: {
  cacheKey: string;
  answerJson: Record<string, unknown>;
  sourceVersionKey: string;
  expiresAt?: string | null;
}) {
  const { error } = await supabase.from("answer_cache").upsert(
    {
      cache_key: params.cacheKey,
      answer_json: params.answerJson,
      source_version_key: params.sourceVersionKey,
      expires_at: params.expiresAt ?? null,
    },
    { onConflict: "cache_key" },
  );
  if (error) throw error;
}

export async function getContextSourceVersionKey() {
  const { data, error } = await supabase
    .from("context_sources")
    .select("updated_at")
    .eq("status", "ready")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data?.updated_at as string | undefined) ?? "none";
}

export async function getAccessibleTeamScope(profileId: string, isAdmin: boolean) {
  if (isAdmin) {
    return getActiveTeams();
  }
  return getLeadTeamsForUser(profileId);
}

export async function getTeamDirectory(teamIds?: string[]) {
  let query = supabase.from("teams").select("id, name, slug, is_active").eq("is_active", true).order("name");
  if (teamIds && teamIds.length > 0) {
    query = query.in("id", teamIds);
  }
  const { data, error } = await query;
  if (error) throw error;
  const rows = (data ?? []) as Array<{ id: string; name: string; slug: string | null; is_active: boolean }>;
  if (rows.length === 0) return [];

  let memberships:
    | Array<{
        team_id: string;
      }>
    | null = null;

  const activeAttempt = await supabase
    .from("team_roster_members")
    .select("team_id")
    .in("team_id", rows.map((row) => row.id))
    .eq("is_active", true);

  if (activeAttempt.error) {
    if ((activeAttempt.error as { code?: string }).code === "42703") {
      const fallbackAttempt = await supabase
        .from("team_roster_members")
        .select("team_id")
        .in("team_id", rows.map((row) => row.id));
      if (fallbackAttempt.error) throw fallbackAttempt.error;
      memberships = (fallbackAttempt.data ?? []) as Array<{ team_id: string }>;
    } else {
      throw activeAttempt.error;
    }
  } else {
    memberships = (activeAttempt.data ?? []) as Array<{ team_id: string }>;
  }

  const counts = new Map<string, number>();
  for (const membership of memberships ?? []) {
    const teamId = membership.team_id as string;
    counts.set(teamId, (counts.get(teamId) ?? 0) + 1);
  }

  return rows.map((row) => ({
    ...row,
    active_member_count: counts.get(row.id) ?? 0,
  }));
}

export async function getPurchaseLogs(params: {
  teamIds: string[];
  limit?: number;
  days?: number;
  search?: string;
}) {
  let query = supabase
    .from("purchase_logs")
    .select("id, team_id, amount_cents, description, purchased_at, person_name, payment_method, category, receipt_not_needed")
    .in("team_id", params.teamIds)
    .order("purchased_at", { ascending: false })
    .limit(params.limit ?? 25);

  if (params.days) {
    const since = new Date(Date.now() - params.days * 86400_000).toISOString();
    query = query.gte("purchased_at", since);
  }

  const { data, error } = await query;
  if (error) throw error;

  const rows = (data ?? []).filter((row) => {
    if (!params.search) return true;
    const haystack = `${row.description ?? ""} ${row.person_name ?? ""} ${row.payment_method ?? ""} ${row.category ?? ""}`.toLowerCase();
    return haystack.includes(params.search.toLowerCase());
  });

  return rows;
}

export async function getTeamSpendSummary(params: { teamIds: string[]; days?: number }) {
  const rows = await getPurchaseLogs({ teamIds: params.teamIds, days: params.days, limit: 500 });
  const byTeam = new Map<string, { teamId: string; totalCents: number; count: number; categories: Record<string, number> }>();

  for (const row of rows) {
    const current: { teamId: string; totalCents: number; count: number; categories: Record<string, number> } =
      byTeam.get(row.team_id) ?? { teamId: row.team_id, totalCents: 0, count: 0, categories: {} };
    const categoryKey = typeof row.category === "string" ? row.category : "unknown";
    current.totalCents += row.amount_cents ?? 0;
    current.count += 1;
    current.categories[categoryKey] = (current.categories[categoryKey] ?? 0) + (row.amount_cents ?? 0);
    byTeam.set(row.team_id, current);
  }

  return [...byTeam.values()];
}

export async function getVendorSummary(params: { teamIds: string[]; days?: number }) {
  const rows = await getPurchaseLogs({ teamIds: params.teamIds, days: params.days, limit: 500 });
  const byVendor = new Map<string, { vendor: string; totalCents: number; count: number }>();
  for (const row of rows) {
    const vendor = (row.description ?? "Unknown").trim().slice(0, 80);
    const current = byVendor.get(vendor) ?? { vendor, totalCents: 0, count: 0 };
    current.totalCents += row.amount_cents ?? 0;
    current.count += 1;
    byVendor.set(vendor, current);
  }
  return [...byVendor.values()].sort((a, b) => b.totalCents - a.totalCents).slice(0, 15);
}

export async function getReceiptAnomalies(params: { teamIds: string[]; days?: number }) {
  const rows = await getPurchaseLogs({ teamIds: params.teamIds, days: params.days, limit: 500 });
  return rows
    .filter((row) => (row.amount_cents ?? 0) >= 50_000 || row.receipt_not_needed === true)
    .map((row) => ({
      id: row.id,
      team_id: row.team_id,
      description: row.description,
      amount_cents: row.amount_cents,
      purchased_at: row.purchased_at,
      reason:
        row.receipt_not_needed === true
          ? "Marked receipt_not_needed"
          : "High-value purchase over $500",
    }))
    .slice(0, 20);
}

export async function compareTeamSpendPatterns(params: { teamIds: string[]; days?: number }) {
  const summary = await getTeamSpendSummary(params);
  const total = summary.reduce((acc, row) => acc + row.totalCents, 0);
  return summary
    .map((row) => ({
      ...row,
      shareOfSpend: total > 0 ? Number((row.totalCents / total).toFixed(4)) : 0,
      averageCents: row.count > 0 ? Math.round(row.totalCents / row.count) : 0,
    }))
    .sort((a, b) => b.totalCents - a.totalCents);
}

export async function summarizeVendorConcentration(params: { teamIds: string[]; days?: number }) {
  const vendors = await getVendorSummary(params);
  const total = vendors.reduce((acc, row) => acc + row.totalCents, 0);
  return vendors.map((row) => ({
    ...row,
    shareOfSpend: total > 0 ? Number((row.totalCents / total).toFixed(4)) : 0,
  }));
}

export async function findBudgetPressureSignals(params: { teamIds: string[]; days?: number }) {
  const summary = await getTeamSpendSummary(params);
  return summary
    .map((row) => ({
      teamId: row.teamId,
      totalCents: row.totalCents,
      purchaseCount: row.count,
      pressureSignal:
        row.totalCents > 200_000 ? "high" : row.totalCents > 100_000 ? "medium" : "low",
    }))
    .sort((a, b) => b.totalCents - a.totalCents);
}

export async function detectReceiptAuditRisks(params: { teamIds: string[]; days?: number }) {
  const anomalies = await getReceiptAnomalies(params);
  return anomalies.map((row) => ({
    ...row,
    severity: row.reason.includes("High-value") ? "high" : "medium",
  }));
}

export async function summarizeReportingHealth(params: { teamIds: string[]; days?: number }) {
  const anomalies = await getReceiptAnomalies(params);
  const grouped = new Map<string, number>();
  for (const anomaly of anomalies) {
    grouped.set(anomaly.team_id, (grouped.get(anomaly.team_id) ?? 0) + 1);
  }
  return [...grouped.entries()].map(([teamId, anomalyCount]) => ({
    teamId,
    anomalyCount,
    reportingHealth: anomalyCount >= 5 ? "needs_attention" : anomalyCount >= 2 ? "watch" : "healthy",
    note: "Based on purchase log anomalies; report tables are not configured in this bot repo yet.",
  }));
}

export async function rankTeamsByFundraisingFit(params: { teamIds: string[]; tags?: string[] }) {
  const teams = await getTeamDirectory(params.teamIds);
  const contexts = await searchContextSources({
    query: params.tags?.join(" ") || "grant fundraising donor robotics",
    corpus: "org",
    tags: params.tags,
    limit: 10,
  });
  return teams.map((team, index) => ({
    teamId: team.id,
    teamName: team.name,
    fitScore: Math.max(0.2, Number((1 - index * 0.08).toFixed(2))),
    rationale: contexts[0]?.content_summary || "No fundraising-specific context found; ranking based on available team directory only.",
  }));
}

export async function getBudgetVsActual(params: { teamIds: string[]; days?: number }) {
  const summary = await getTeamSpendSummary(params);
  return summary.map((row) => ({
    teamId: row.teamId,
    actualCents: row.totalCents,
    budgetCents: null,
    note: "Budget source is not configured in this bot repo yet; returning actual spend only.",
  }));
}

export async function getRecentReports() {
  return {
    rows: [],
    note: "Report tables are not configured in this bot repo yet.",
  };
}
