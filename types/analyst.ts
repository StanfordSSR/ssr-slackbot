export type AnalystRoute =
  | "casual"
  | "org_profile"
  | "policy"
  | "finance"
  | "fundraising"
  | "audit"
  | "mixed"
  | "needs_web";

export type ModelTier = "mini" | "deep";

export type CostTier = "light" | "standard" | "heavy";

export type ToolName =
  | "get_org_profile"
  | "get_team_directory"
  | "get_team_spend_summary"
  | "get_purchase_log_rows"
  | "get_vendor_summary"
  | "get_budget_vs_actual"
  | "get_receipt_anomalies"
  | "get_recent_reports"
  | "search_context_metadata"
  | "compare_team_spend_patterns"
  | "rank_teams_by_fundraising_fit"
  | "summarize_reporting_health"
  | "detect_receipt_audit_risks"
  | "summarize_vendor_concentration"
  | "find_budget_pressure_signals";

export type PlannerToolCall = {
  tool: ToolName;
  rationale: string;
  params: Record<string, unknown>;
};

export type DocumentSearchPlan = {
  query: string;
  corpus: "org" | "internal" | "both";
  tags: string[];
  limit: number;
};

export type AnalystPlan = {
  route: AnalystRoute;
  answerCasually: boolean;
  modelTier: ModelTier;
  subquestions: string[];
  needsOrgProfile: boolean;
  needsStructuredData: boolean;
  needsDocuments: boolean;
  needsWeb: boolean;
  structuredTools: PlannerToolCall[];
  documentSearches: DocumentSearchPlan[];
};

export type AnalystEvidence = {
  sourceKind: "org_profile" | "context_source" | "structured_tool" | "web";
  title: string;
  citationText: string;
  sourceRef?: string | null;
  metadata?: Record<string, unknown>;
};

export type AnalystAnswer = {
  answer: string;
  evidenceBullets: string[];
  whyItMatters?: string | null;
  confidenceLine: string;
  estimatedCostUsd: number;
  costTier: CostTier;
  modelTier: ModelTier;
};

export type ContextSourceRecord = {
  id: string;
  title: string;
  source_type: "url" | "slack_file";
  source_url: string | null;
  corpus: "org" | "internal";
  scope: "org" | "team";
  team_id: string | null;
  tags: string[];
  is_canonical: boolean;
  canonical_kind: string | null;
  mime_type: string | null;
  openai_file_id: string | null;
  openai_vector_store_id: string | null;
  content_text: string | null;
  content_summary: string | null;
  status: "processing" | "ready" | "failed";
  error_text: string | null;
};
