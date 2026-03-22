import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { AnalystAnswer, AnalystEvidence, AnalystPlan, CostTier, ModelTier } from "@/types/analyst";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const plannerSchema = z.object({
  route: z.enum(["casual", "org_profile", "policy", "finance", "fundraising", "audit", "mixed", "needs_web"]),
  answerCasually: z.boolean(),
  modelTier: z.enum(["mini", "deep"]),
  subquestions: z.array(z.string()).max(6),
  needsOrgProfile: z.boolean(),
  needsStructuredData: z.boolean(),
  needsDocuments: z.boolean(),
  needsWeb: z.boolean(),
  sqlQueries: z
    .array(
      z.object({
        rationale: z.string(),
        sql: z.string().describe("Read-only SQL using allowlisted public schema tables. Prefer explicit table names and project team_id when team-scoped."),
        expectedAnswerUse: z.string(),
      }),
    )
    .max(3),
  structuredTools: z
    .array(
      z.object({
        tool: z.enum([
          "get_org_profile",
          "get_team_directory",
          "get_team_spend_summary",
          "get_purchase_log_rows",
          "get_vendor_summary",
          "get_budget_vs_actual",
          "get_receipt_anomalies",
          "get_recent_reports",
          "search_context_metadata",
          "compare_team_spend_patterns",
          "rank_teams_by_fundraising_fit",
          "summarize_reporting_health",
          "detect_receipt_audit_risks",
          "summarize_vendor_concentration",
          "find_budget_pressure_signals",
        ]),
        rationale: z.string(),
        paramsJson: z
          .string()
          .describe("JSON object string for tool parameters. Use {} when no params are needed."),
      }),
    )
    .max(6),
  documentSearches: z
    .array(
      z.object({
        query: z.string(),
        corpus: z.enum(["org", "internal", "both"]),
        tags: z.array(z.string()).max(8),
        limit: z.number().int().min(1).max(5),
      }),
    )
    .max(2),
});

const followUpSchema = z.object({
  needAnotherStep: z.boolean(),
  rationale: z.string(),
  nextTools: z
    .array(
      z.object({
        tool: z.enum([
          "get_org_profile",
          "get_team_directory",
          "get_team_spend_summary",
          "get_purchase_log_rows",
          "get_vendor_summary",
          "get_budget_vs_actual",
          "get_receipt_anomalies",
          "get_recent_reports",
          "search_context_metadata",
          "compare_team_spend_patterns",
          "rank_teams_by_fundraising_fit",
          "summarize_reporting_health",
          "detect_receipt_audit_risks",
          "summarize_vendor_concentration",
          "find_budget_pressure_signals",
        ]),
        rationale: z.string(),
        paramsJson: z
          .string()
          .describe("JSON object string for tool parameters. Use {} when no params are needed."),
      }),
    )
    .max(2),
  nextDocumentSearches: z
    .array(
      z.object({
        query: z.string(),
        corpus: z.enum(["org", "internal", "both"]),
        tags: z.array(z.string()).max(8),
        limit: z.number().int().min(1).max(5),
      }),
    )
    .max(1),
});

const answerSchema = z.object({
  answer: z.string(),
  evidenceBullets: z.array(z.string()).max(5),
  whyItMatters: z.string().nullable(),
  confidenceLine: z.string(),
});

const orgProfileSchema = z.object({
  profileText: z.string(),
});

const sqlRepairSchema = z.object({
  sql: z.string(),
  rationale: z.string(),
});

const directSqlSchema = z.object({
  shouldUseDirectSql: z.boolean(),
  rationale: z.string(),
  sql: z.string(),
  expectedAnswerUse: z.string(),
});

export type UsageTotals = {
  inputTokens: number;
  outputTokens: number;
  fileSearchCalls: number;
  webSearchCalls: number;
};

function getModelName(tier: ModelTier) {
  return tier === "deep" ? "gpt-5.1" : "gpt-5-mini";
}

function choosePlannerModel(prompt: string) {
  const lower = prompt.toLowerCase();
  const looksStructured =
    /(sql|schema|table|column|database|supabase|query|join|group by|team_roster_members|purchase_logs)/.test(lower)
    || /(budget|report|finance|audit|vendor|spend|expense|monthly|per person|member count)/.test(lower);
  return looksStructured ? "gpt-5.1" : "gpt-5-mini";
}

function safeUsage(response: unknown) {
  const usage = (response as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
  };
}

export async function planAnalystQuestion(input: {
  prompt: string;
  history: Array<{ speaker: string; text: string }>;
  accessibleTeams: Array<{ id: string; name: string }>;
  schemaCatalogText: string;
}) {
  const historyText =
    input.history.length > 0 ? input.history.map((message) => `${message.speaker}: ${message.text}`).join("\n") : "(none)";
  const teamsText =
    input.accessibleTeams.length > 0
      ? input.accessibleTeams.map((team) => `${team.name} (${team.id})`).join(", ")
      : "(no restricted team access)";

  const response = await client.responses.parse({
    model: choosePlannerModel(input.prompt),
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text:
              "You are a routing and planning system for an SSR Slack analyst. Choose the minimum evidence needed for a reliable answer. Keep plans compact, accuracy-first, and latency-aware. Prefer targeted SQL over the live schema catalog for structured finance/roster/reporting questions. Use SQL when the question depends on live Supabase facts, especially team size, budgets, reports, purchases, line items, or dates. Only choose needsWeb when the question is explicitly about live external information. Scope rule: if the user says SSR, club, organization, or overall, interpret that as all accessible SSR teams. Timeframe rule: interpret 'this year' as the current calendar year unless the user explicitly says 'academic year'. Do not silently substitute academic-year logic for calendar-year questions. SQL rules: output bare read-only SQL only, no prose, no markdown fences; prefer explicit public.table names; for team-size use public.team_roster_members, not public.team_memberships; for spend timing use purchase_logs.purchased_at, not receipt upload times; for team-scoped SQL project team_id in the final select when possible; for month rollups use date_trunc('month', purchased_at).",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Accessible teams: ${teamsText}\nSchema catalog:\n${input.schemaCatalogText}\n\nRecent Slack context:\n${historyText}\n\nQuestion:\n${input.prompt}`,
          },
        ],
      },
    ],
    text: {
      format: zodTextFormat(plannerSchema, "analyst_plan"),
    },
  });

  if (!response.output_parsed) {
    throw new Error("Planner did not return a parsed plan.");
  }

  return {
    plan: response.output_parsed as AnalystPlan,
    usage: safeUsage(response),
  };
}

export async function decideAnalystFollowUp(input: {
  prompt: string;
  plan: AnalystPlan;
  evidence: AnalystEvidence[];
  round: number;
}) {
  const evidenceText = input.evidence
    .map((item, index) => `${index + 1}. [${item.sourceKind}] ${item.title}: ${item.citationText}`)
    .join("\n");

  const response = await client.responses.parse({
    model: choosePlannerModel(input.prompt),
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text:
              "You are deciding whether one more evidence-gathering step would materially improve an SSR analyst answer. Be conservative. If the evidence is already adequate, stop. Only request one more targeted step if it would clearly improve accuracy.",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Round: ${input.round}\nPlan: ${JSON.stringify(input.plan)}\nQuestion: ${input.prompt}\nEvidence:\n${evidenceText}`,
          },
        ],
      },
    ],
    text: {
      format: zodTextFormat(followUpSchema, "analyst_followup"),
    },
  });

  if (!response.output_parsed) {
    throw new Error("Follow-up planner did not return a parsed result.");
  }

  return {
    decision: response.output_parsed,
    usage: safeUsage(response),
  };
}

export async function synthesizeAnalystAnswer(input: {
  prompt: string;
  plan: AnalystPlan;
  orgProfile: string | null;
  evidence: AnalystEvidence[];
  modelTier: ModelTier;
}) {
  const evidenceText = input.evidence
    .map((item) => `- ${item.title}: ${item.citationText}`)
    .join("\n");

  const response = await client.responses.parse({
    model: getModelName(input.modelTier),
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text:
              "You are SSR_HQ's analysis engine. Answer accurately and concisely. Separate facts from interpretation. Do not claim certainty when evidence is incomplete. Keep the direct answer short, then provide compact evidence bullets, then one confidence/caveat line.",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Question:\n${input.prompt}\n\nPlan:\n${JSON.stringify(input.plan)}\n\nOrg profile:\n${input.orgProfile ?? "(none)"}\n\nEvidence:\n${evidenceText}`,
          },
        ],
      },
    ],
    text: {
      format: zodTextFormat(answerSchema, "analyst_answer"),
    },
  });

  if (!response.output_parsed) {
    throw new Error("Synthesis did not return a parsed answer.");
  }

  return {
    answer: response.output_parsed,
    usage: safeUsage(response),
  };
}

export async function repairAnalystSql(input: {
  prompt: string;
  sql: string;
  errorText: string;
  schemaCatalogText: string;
  accessibleTeams: Array<{ id: string; name: string }>;
}) {
  const teamsText =
    input.accessibleTeams.length > 0
      ? input.accessibleTeams.map((team) => `${team.name} (${team.id})`).join(", ")
      : "(no restricted team access)";

  const response = await client.responses.parse({
    model: "gpt-5-mini",
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text:
              "You repair read-only SQL for an SSR Slack analyst. Return only a corrected SQL query and a terse rationale. Do not add markdown fences or commentary. Keep it SELECT/CTE only. Use explicit public.table names. Timeframe rule: interpret 'this year' as the current calendar year unless the user explicitly says 'academic year'. For team-scoped queries, keep team_id in the final projection. For team-size use public.team_roster_members. For spend timing use purchase_logs.purchased_at.",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Question: ${input.prompt}\nAccessible teams: ${teamsText}\nSchema catalog:\n${input.schemaCatalogText}\n\nOriginal SQL:\n${input.sql}\n\nError:\n${input.errorText}`,
          },
        ],
      },
    ],
    text: {
      format: zodTextFormat(sqlRepairSchema, "analyst_sql_repair"),
    },
  });

  if (!response.output_parsed) {
    throw new Error("SQL repair did not return a parsed result.");
  }

  return {
    repair: response.output_parsed,
    usage: safeUsage(response),
  };
}

export async function planDirectSqlQuestion(input: {
  prompt: string;
  history: Array<{ speaker: string; text: string }>;
  accessibleTeams: Array<{ id: string; name: string }>;
  schemaCatalogText: string;
}) {
  const historyText =
    input.history.length > 0 ? input.history.map((message) => `${message.speaker}: ${message.text}`).join("\n") : "(none)";
  const teamsText =
    input.accessibleTeams.length > 0
      ? input.accessibleTeams.map((team) => `${team.name} (${team.id})`).join(", ")
      : "(no restricted team access)";

  const response = await client.responses.parse({
    model: "gpt-5.1",
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text:
              "You decide whether an SSR Slack question should be answered directly from structured database SQL. Use direct SQL when the question is primarily about counts, rankings, comparisons, rollups, categories, purchases, budgets, reports, roster sizes, or other factual Supabase-backed metrics. Return one strong read-only SQL query when direct SQL is appropriate. Output bare SQL only, no prose, no markdown fences. Scope rule: if the user says SSR, club, organization, or overall, interpret that as all accessible SSR teams. Timeframe rule: interpret 'this year' as the current calendar year unless the user explicitly says 'academic year'. Use explicit public.table names. For team-size use public.team_roster_members. For spend timing use purchase_logs.purchased_at. For team-scoped queries project team_id in the final select when possible.",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Accessible teams: ${teamsText}\nSchema catalog:\n${input.schemaCatalogText}\n\nRecent Slack context:\n${historyText}\n\nQuestion:\n${input.prompt}`,
          },
        ],
      },
    ],
    text: {
      format: zodTextFormat(directSqlSchema, "direct_sql_plan"),
    },
  });

  if (!response.output_parsed) {
    throw new Error("Direct SQL planner did not return a parsed result.");
  }

  return {
    plan: response.output_parsed,
    usage: safeUsage(response),
  };
}

export async function buildOrgProfileFromSources(input: {
  canonicalTexts: Array<{ title: string; text: string }>;
  teamDirectory: Array<{ id: string; name: string; slug?: string | null }>;
}) {
  const texts = input.canonicalTexts.map((item) => `# ${item.title}\n${item.text}`).join("\n\n");
  const teams = input.teamDirectory.map((team) => `${team.name}${team.slug ? ` (${team.slug})` : ""}`).join(", ");

  const response = await client.responses.parse({
    model: "gpt-5-mini",
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text:
              "Build a compact, always-on SSR institutional profile under 220 words. Keep only stable, high-signal context: mission, Stanford framing, teams, vocabulary, and operating context. Do not include volatile or low-signal detail.",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Canonical docs:\n${texts || "(none)"}\n\nTeams:\n${teams || "(none)"}`,
          },
        ],
      },
    ],
    text: {
      format: zodTextFormat(orgProfileSchema, "org_profile_artifact"),
    },
  });

  if (!response.output_parsed) {
    throw new Error("Org profile builder did not return a parsed profile.");
  }

  return {
    profileText: response.output_parsed.profileText,
    usage: safeUsage(response),
  };
}

export async function summarizeContextDocument(input: {
  title: string;
  text: string;
  tags: string[];
}) {
  const response = await client.responses.create({
    model: "gpt-5-mini",
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text:
              "Summarize this SSR/Stanford context source in 4-6 concise sentences for routing and retrieval. Focus on what decisions/questions it helps answer. Mention policy, grants, finance, fundraising, or team relevance when present.",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Title: ${input.title}\nTags: ${input.tags.join(", ")}\n\nDocument:\n${input.text.slice(0, 20000)}`,
          },
        ],
      },
    ],
  });

  const text = response.output_text?.trim();
  if (!text) {
    throw new Error("Context summarizer returned no text.");
  }

  return {
    summary: text,
    usage: safeUsage(response),
  };
}

export async function summarizeBinaryDocument(input: {
  title: string;
  dataUrl: string;
  filename: string;
  mimeType: string;
  tags: string[];
}) {
  const fileContent =
    input.mimeType === "application/pdf"
      ? {
          type: "input_file" as const,
          file_data: input.dataUrl,
          filename: input.filename,
        }
      : {
          type: "input_image" as const,
          image_url: input.dataUrl,
          detail: "auto" as const,
        };

  const response = await client.responses.create({
    model: "gpt-5-mini",
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text:
              "Summarize this SSR/Stanford document in 4-6 concise sentences. Focus on what decisions, policy questions, grant opportunities, or finance/audit questions it helps answer. Mention important constraints or deadlines when visible.",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Title: ${input.title}\nTags: ${input.tags.join(", ")}\nFilename: ${input.filename}`,
          },
          fileContent,
        ],
      },
    ],
  });

  const text = response.output_text?.trim();
  if (!text) {
    throw new Error("Binary document summarizer returned no text.");
  }

  return {
    summary: text,
    usage: safeUsage(response),
  };
}

export function estimateAnalysisCost(input: {
  usage: UsageTotals;
  modelTier: ModelTier;
}): { costTier: CostTier; estimatedCostUsd: number } {
  const inputRate = input.modelTier === "deep" ? 1.25 / 1_000_000 : 0.25 / 1_000_000;
  const outputRate = input.modelTier === "deep" ? 10 / 1_000_000 : 2 / 1_000_000;

  const modelCost = input.usage.inputTokens * inputRate + input.usage.outputTokens * outputRate;
  const fileSearchCost = input.usage.fileSearchCalls * 0.0025;
  const estimatedCostUsd = Number((modelCost + fileSearchCost).toFixed(6));

  let costTier: CostTier = "light";
  if (input.modelTier === "deep" || input.usage.fileSearchCalls >= 2 || estimatedCostUsd >= 0.02) {
    costTier = "heavy";
  } else if (input.usage.fileSearchCalls >= 1 || input.usage.inputTokens + input.usage.outputTokens > 5000) {
    costTier = "standard";
  }

  return { costTier, estimatedCostUsd };
}
