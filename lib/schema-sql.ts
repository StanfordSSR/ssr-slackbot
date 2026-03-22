import { createHash } from "node:crypto";
import {
  completeSchemaRefreshRun,
  executeGuardedSql,
  failSchemaRefreshRun,
  getLiveSchemaColumns,
  getLiveSchemaRelationships,
  getSchemaCatalog,
  recordQuestionSqlQuery,
  replaceSchemaCatalog,
  startSchemaRefreshRun,
} from "@/lib/analyst-store";
import { SchemaCatalogColumn, SchemaCatalogTable } from "@/types/analyst";

const BLOCKED_TABLES = new Set([
  "public.audit_log_entries",
  "public.internal_notification_requests",
  "public.question_sessions",
  "public.question_tool_calls",
  "public.question_sql_queries",
  "public.answer_cache",
  "public.context_sources",
]);

export async function refreshSchemaCatalog() {
  const runId = await startSchemaRefreshRun();
  try {
    const liveColumns = await getLiveSchemaColumns();
    const liveRelationships = await getLiveSchemaRelationships();

    const tableMap = new Map<string, { schema_name: string; table_name: string; table_kind: string; columns: typeof liveColumns }>();

    for (const row of liveColumns) {
      const key = `${row.schema_name}.${row.table_name}`;
      const current = tableMap.get(key) ?? {
        schema_name: row.schema_name,
        table_name: row.table_name,
        table_kind: row.table_kind,
        columns: [],
      };
      current.columns.push(row);
      tableMap.set(key, current);
    }

    const tables = [...tableMap.values()].map((table) => describeTable(table.schema_name, table.table_name, table.table_kind, table.columns));
    const columns = [...tableMap.values()].flatMap((table) =>
      table.columns.map((column) => describeColumn(`${table.schema_name}.${table.table_name}`, table.table_name, column)),
    );
    const relationships = liveRelationships
      .filter((relationship) => relationship.from_schema === "public" && relationship.to_schema === "public")
      .map((relationship) => ({
        fromTableKey: `${relationship.from_schema}.${relationship.from_table}`,
        fromColumnName: relationship.from_column,
        toTableKey: `${relationship.to_schema}.${relationship.to_table}`,
        toColumnName: relationship.to_column,
        relationshipKind: "foreign_key",
      }));

    await replaceSchemaCatalog({
      tables,
      columns,
      relationships,
    });

    await completeSchemaRefreshRun({
      runId,
      refreshedTables: tables.length,
      refreshedColumns: columns.length,
      refreshedRelationships: relationships.length,
    });

    return {
      refreshedTables: tables.length,
      refreshedColumns: columns.length,
      refreshedRelationships: relationships.length,
    };
  } catch (error) {
    await failSchemaRefreshRun(runId, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export async function getSchemaCatalogText() {
  const catalog = await getSchemaCatalog();
  if (catalog.tables.length === 0) {
    try {
      const refreshed = await refreshSchemaCatalog();
      if (refreshed.refreshedTables === 0) {
        return fallbackSchemaCatalogText();
      }
    } catch {
      return fallbackSchemaCatalogText();
    }
  }

  const latest = await getSchemaCatalog();
  if (latest.tables.length === 0) {
    return fallbackSchemaCatalogText();
  }
  const columnsByTable = new Map<string, SchemaCatalogColumn[]>();
  for (const column of latest.columns) {
    const current = columnsByTable.get(column.table_id) ?? [];
    current.push(column);
    columnsByTable.set(column.table_id, current);
  }

  return latest.tables
    .map((table) => {
      const cols = (columnsByTable.get(table.id) ?? []).slice(0, 16).map((column) => `${column.column_name}:${column.data_type}`).join(", ");
      const semantics = table.semantic_roles.length > 0 ? ` roles=${table.semantic_roles.join("|")}` : "";
      const scope = ` scope=${table.scope_kind}`;
      const timeCol = table.preferred_time_column ? ` time=${table.preferred_time_column}` : "";
      const description = table.description ? ` desc="${table.description}"` : "";
      return `${table.schema_name}.${table.table_name}${scope}${timeCol}${semantics}${description} columns=[${cols}]`;
    })
    .join("\n");
}

export async function validateAndExecuteSql(params: {
  sessionId: string;
  stepIndex: number;
  rationale: string;
  sql: string;
  isAdmin: boolean;
  allowedTeamIds: string[];
}) {
  const catalog = await getSchemaCatalog();
  if (catalog.tables.length === 0) {
    throw new Error("Schema catalog is not available yet. Run /refreshschema after applying the schema SQL migration.");
  }
  const trimmedSql = normalizeSqlCandidate(params.sql);
  const normalized = trimmedSql.replace(/\s+/g, " ").trim();
  const lower = normalized.toLowerCase();

  if (!/^\s*(select|with)\b/.test(lower)) {
    throw new Error("Only SELECT/CTE SQL is allowed.");
  }
  if (/[;](?=.*\S)/.test(trimmedSql)) {
    throw new Error("Multiple statements are not allowed.");
  }
  if (/\b(insert|update|delete|drop|alter|create|grant|revoke|truncate|merge|copy|comment|execute|call|do)\b/.test(lower)) {
    throw new Error("Mutating SQL is not allowed.");
  }

  const referencedTables = extractReferencedTables(lower).filter((tableName) => !BLOCKED_TABLES.has(tableName));
  if (referencedTables.length === 0) {
    throw new Error("Could not identify any allowlisted tables in the SQL.");
  }

  const tableByName = new Map(catalog.tables.map((table) => [`${table.schema_name}.${table.table_name}`, table]));
  for (const tableName of referencedTables) {
    const table = tableByName.get(tableName);
    if (!table || !table.is_queryable || table.access_level === "blocked") {
      throw new Error(`Table ${tableName} is not queryable from Slack.`);
    }
    if (table.access_level === "admin_only" && !params.isAdmin) {
      throw new Error(`Table ${tableName} is admin-only.`);
    }
  }

  let executedSql = normalized;
  const teamScopedTables = referencedTables
    .map((tableName) => tableByName.get(tableName))
    .filter((table): table is SchemaCatalogTable => Boolean(table && table.scope_kind === "team" && table.team_scope_column));

  if (!params.isAdmin && teamScopedTables.length > 0) {
    const hasTeamIdInProjection = /\bteam_id\b/.test(lower);
    if (!hasTeamIdInProjection) {
      throw new Error("Team-scoped SQL must project a team_id column for non-admin callers.");
    }
    const teamList = params.allowedTeamIds.map((teamId) => `'${teamId.replace(/'/g, "''")}'`).join(", ");
    executedSql = `select * from (${normalized}) as scoped_query where scoped_query.team_id in (${teamList}) limit 100`;
  }

  const startedAt = Date.now();
  try {
    const rows = await executeGuardedSql({
      sql: executedSql,
      maxRows: 100,
      timeoutMs: 4000,
    });
    const durationMs = Date.now() - startedAt;
    const fingerprint = createHash("sha1").update(executedSql).digest("hex");

    await recordQuestionSqlQuery({
      sessionId: params.sessionId,
      stepIndex: params.stepIndex,
      rationale: params.rationale,
      proposedSql: params.sql,
      executedSql,
      sqlFingerprint: fingerprint,
      referencedTables,
      rowCount: rows.length,
      durationMs,
      status: "executed",
      resultPreview: rows.slice(0, 5),
    });

    return {
      rows,
      executedSql,
      sqlFingerprint: fingerprint,
      referencedTables,
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    await recordQuestionSqlQuery({
      sessionId: params.sessionId,
      stepIndex: params.stepIndex,
      rationale: params.rationale,
      proposedSql: params.sql,
      executedSql,
      referencedTables,
      rowCount: 0,
      durationMs,
      status: "failed",
      errorText: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function describeTable(
  schemaName: string,
  tableName: string,
  tableKind: string,
  columns: Array<{ column_name: string; data_type: string }>,
): Omit<SchemaCatalogTable, "id"> {
  const fullName = `${schemaName}.${tableName}`;
  const teamScopeColumn = columns.some((column) => column.column_name === "team_id") ? "team_id" : null;
  const semanticRoles = inferTableSemanticRoles(tableName);
  return {
    schema_name: schemaName,
    table_name: tableName,
    table_kind: tableKind,
    description: describeTableName(tableName),
    scope_kind: inferTableScope(tableName, teamScopeColumn),
    team_scope_column: teamScopeColumn,
    access_level: BLOCKED_TABLES.has(fullName) ? "blocked" : inferTableAccess(tableName),
    semantic_roles: semanticRoles,
    preferred_time_column: inferPreferredTimeColumn(columns.map((column) => column.column_name)),
    is_queryable: !BLOCKED_TABLES.has(fullName),
    row_count_hint: null,
  };
}

function describeColumn(
  tableKey: string,
  tableName: string,
  column: {
    column_name: string;
    data_type: string;
    is_nullable: boolean;
    ordinal_position: number;
  },
) {
  return {
    tableKey,
    column_name: column.column_name,
    data_type: column.data_type,
    is_nullable: column.is_nullable,
    ordinal_position: column.ordinal_position,
    semantic_roles: inferColumnSemanticRoles(tableName, column.column_name),
    is_queryable: true,
  };
}

function inferTableScope(tableName: string, teamScopeColumn: string | null): "org" | "team" | "admin_only" | "blocked" {
  if (tableName === "profiles") return "admin_only";
  if (teamScopeColumn || /team_|purchase|budget|report|receipt|roster/i.test(tableName)) return "team";
  return "org";
}

function inferTableAccess(tableName: string): "standard" | "admin_only" | "blocked" {
  if (tableName === "profiles") return "admin_only";
  return "standard";
}

function inferTableSemanticRoles(tableName: string) {
  const roles: string[] = [];
  if (tableName === "team_roster_members") roles.push("team_size");
  if (tableName === "team_memberships") roles.push("portal_roles");
  if (tableName === "purchase_logs") roles.push("purchase_time", "expenses");
  if (/budget/i.test(tableName)) roles.push("budget");
  if (/report/i.test(tableName)) roles.push("reporting_status");
  if (/line_item/i.test(tableName)) roles.push("purchase_lines");
  return roles;
}

function inferColumnSemanticRoles(tableName: string, columnName: string) {
  const roles: string[] = [];
  if (tableName === "purchase_logs" && columnName === "purchased_at") roles.push("purchase_time");
  if (tableName === "purchase_logs" && columnName === "receipt_uploaded_at") roles.push("receipt_upload_time");
  if (tableName === "team_roster_members" && /name|email|sunet/i.test(columnName)) roles.push("student_roster_field");
  return roles;
}

function inferPreferredTimeColumn(columnNames: string[]) {
  if (columnNames.includes("purchased_at")) return "purchased_at";
  if (columnNames.includes("report_date")) return "report_date";
  if (columnNames.includes("created_at")) return "created_at";
  return null;
}

function describeTableName(tableName: string) {
  if (tableName === "team_roster_members") return "Full team roster members, better source of truth for team size than portal memberships.";
  if (tableName === "team_memberships") return "Portal user memberships and roles.";
  if (tableName === "purchase_logs") return "Logged team purchases and expense records.";
  return tableName.replace(/_/g, " ");
}

function extractReferencedTables(sql: string) {
  const matches = [...sql.matchAll(/\b(?:from|join)\s+([a-z0-9_."]+)/gi)];
  return [...new Set(matches.map((match) => match[1].replace(/"/g, "")).map((name) => (name.includes(".") ? name : `public.${name}`)))];
}

function normalizeSqlCandidate(sql: string) {
  let cleaned = sql.trim();

  cleaned = cleaned.replace(/^```(?:sql)?\s*/i, "").replace(/\s*```$/i, "");
  cleaned = cleaned.replace(/^\s*sql\s*:\s*/i, "");
  cleaned = cleaned.replace(/^\s*query\s*:\s*/i, "");

  const firstQueryIndex = cleaned.search(/\b(select|with)\b/i);
  if (firstQueryIndex > 0) {
    cleaned = cleaned.slice(firstQueryIndex);
  }

  cleaned = cleaned.replace(/;\s*$/, "").trim();
  return cleaned;
}

function fallbackSchemaCatalogText() {
  return [
    "public.teams scope=org columns=[id:uuid, name:text, slug:text, is_active:boolean]",
    "public.team_roster_members scope=team roles=team_size columns=[team_id:uuid]",
    "public.team_memberships scope=team roles=portal_roles columns=[team_id:uuid, user_id:uuid, team_role:text, is_active:boolean]",
    "public.purchase_logs scope=team time=purchased_at roles=purchase_time|expenses columns=[id:uuid, team_id:uuid, amount_cents:bigint, description:text, purchased_at:timestamptz, person_name:text, payment_method:text, category:text, receipt_uploaded_at:timestamptz]",
    "public.email_receipt_ingestions scope=team columns=[id:uuid, team_id:uuid, subject:text, received_at:timestamptz, status:text]",
    "public.amazon_order_ingestions scope=team columns=[id:uuid, claimed_team_id:uuid, purchase_date:date, amount_total:numeric, item_name:text, status:text]",
  ].join("\n");
}
