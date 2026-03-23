import { createHash } from "node:crypto";
import {
  addQuestionEvidence,
  compareTeamSpendPatterns,
  completeQuestionSession,
  createQuestionSession,
  detectReceiptAuditRisks,
  failQuestionSession,
  findBudgetPressureSignals,
  getAccessibleTeamScope,
  getAnswerCache,
  getBudgetVsActual,
  getContextSourceVersionKey,
  getMonthlySpendByCategoryForTeams,
  getMonthlyMemberCountsForTeams,
  getMonthlySpendForTeams,
  getPurchaseCountForTeams,
  getPurchaseCountsByMonthForTeams,
  getTopPurchasesForTeams,
  getPurchaseLogs,
  getRecentReports,
  getTeamDirectory,
  getTeamMonthlyMemberCounts,
  getTeamMonthlySpend,
  getTeamSpendSummary,
  getVendorSummary,
  rankTeamsByFundraisingFit,
  recordQuestionToolCall,
  searchContextSources,
  summarizeReportingHealth,
  summarizeVendorConcentration,
  upsertAnswerCache,
  updateQuestionSessionPlan,
} from "@/lib/analyst-store";
import {
  decideAnalystFollowUp,
  estimateAnalysisCost,
  planAnalystQuestion,
  planDirectSqlQuestion,
  repairAnalystSql,
  synthesizeAnalystAnswer,
  UsageTotals,
} from "@/lib/analyst-openai";
import { getCachedOrgProfile, searchContextForQuestion } from "@/lib/context-ingestion";
import { AnalystAnswer, AnalystEvidence, AnalystPlan, PlannerToolCall, ToolName } from "@/types/analyst";
import { getSchemaCatalogText, validateAndExecuteSql } from "@/lib/schema-sql";

type AnalystCaller = {
  slackUserId: string;
  profileId: string;
  isAdmin: boolean;
  channelId?: string | null;
  threadTs?: string | null;
  entrypoint: "mention" | "slash_command";
};

type AnalystProgressStage =
  | "routing"
  | "reviewing_org_profile"
  | "running_tools"
  | "reviewing_documents"
  | "checking_gaps"
  | "writing_answer";

const LIGHTWEIGHT_PATTERNS = [
  /^(hi|hey|hello|yo|sup|hiya|howdy)[!.?]*$/i,
  /^(thanks|thank you|ty)[!.?]*$/i,
  /^(good morning|good afternoon|good evening)[!.?]*$/i,
  /^(who are you|what are you)$/i,
];

export async function runAnalystSession(params: {
  caller: AnalystCaller;
  prompt: string;
  history?: Array<{ speaker: string; text: string }>;
  onProgress?: (stage: AnalystProgressStage, detail: string) => Promise<void> | void;
}) {
  const normalizedPrompt = normalizePrompt(params.prompt);
  if (shouldUseLightweightReply(normalizedPrompt)) {
    return {
      answer: "",
      evidenceBullets: [],
      whyItMatters: null,
      confidenceLine: "",
      estimatedCostUsd: 0,
      costTier: "light" as const,
      modelTier: "mini" as const,
      lightweight: true,
    };
  }

  const promptConstraints = inferPromptConstraints(params.prompt);
  const accessibleTeams = await getAccessibleTeamScope(params.caller.profileId, params.caller.isAdmin);
  const deterministic = await maybeHandleDeterministicPrompt({
    prompt: params.prompt,
    normalizedPrompt,
    accessibleTeams,
    history: params.history ?? [],
  });
  if (deterministic) {
    return deterministic;
  }
  const scopeKey = params.caller.isAdmin ? "admin:all" : accessibleTeams.map((team) => team.id).sort().join(",");
  const contextVersion = await getContextSourceVersionKey();
  const cacheKey = createHash("sha1").update(`${normalizedPrompt}|${scopeKey}|${contextVersion}`).digest("hex");

  const cached = await getAnswerCache(cacheKey);
  if (cached) {
    return cached as AnalystAnswer & { cached: true };
  }

  const sessionId = await createQuestionSession({
    slackUserId: params.caller.slackUserId,
    profileId: params.caller.profileId,
    channelId: params.caller.channelId ?? null,
    threadTs: params.caller.threadTs ?? null,
    entrypoint: params.caller.entrypoint,
    prompt: params.prompt,
    normalizedPrompt,
    cacheKey,
  });

  const usage: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    fileSearchCalls: 0,
    webSearchCalls: 0,
  };

  try {
    await reportProgress(params.onProgress, "routing", "routing your question");
    const schemaCatalogText = await getSchemaCatalogText();
    const allowedTeamIds = accessibleTeams.map((team) => team.id);
    const directAnswer = await tryDirectSqlAnswer({
      sessionId,
      prompt: params.prompt,
      history: params.history ?? [],
      accessibleTeams: accessibleTeams.map((team) => ({ id: team.id, name: team.name })),
      allowedTeamIds,
      isAdmin: params.caller.isAdmin,
      schemaCatalogText,
      usage,
      onProgress: params.onProgress,
    });
    if (directAnswer) {
      await completeQuestionSession({
        sessionId,
        finalAnswer: directAnswer.answer,
        confidenceLabel: directAnswer.confidenceLine,
        modelTier: directAnswer.modelTier,
        costTier: directAnswer.costTier,
        estimatedCostUsd: directAnswer.estimatedCostUsd,
        usage: usage as unknown as Record<string, unknown>,
      });
      return directAnswer;
    }

    const planned = await planAnalystQuestion({
      prompt: params.prompt,
      history: params.history ?? [],
      accessibleTeams: accessibleTeams.map((team) => ({ id: team.id, name: team.name })),
      schemaCatalogText,
    });
    accumulateUsage(usage, planned.usage);
    let plan = planned.plan;

    await updateQuestionSessionPlan(sessionId, plan.route, plan as unknown as Record<string, unknown>);

    const evidence: AnalystEvidence[] = [];

    if (plan.needsOrgProfile || plan.route === "org_profile" || plan.route === "casual") {
      await reportProgress(params.onProgress, "reviewing_org_profile", "reviewing SSR org context");
      const orgProfile = await getCachedOrgProfile();
      if (orgProfile) {
        evidence.push({
          sourceKind: "org_profile",
          title: "SSR Org Profile",
          citationText: orgProfile,
        });
        await addQuestionEvidence({
          sessionId,
          sourceKind: "org_profile",
          title: "SSR Org Profile",
          citationText: orgProfile,
        });
      }
    }

    if (plan.structuredTools.length > 0) {
      await reportProgress(params.onProgress, "running_tools", describeToolProgress(plan.structuredTools));
    }
    await executePlanTools({
      sessionId,
      evidence,
      tools: plan.structuredTools,
      allowedTeamIds,
      stepOffset: 0,
      promptConstraints,
    });

    if (plan.sqlQueries.length > 0) {
      await reportProgress(params.onProgress, "running_tools", "running finance queries");
    }
    await executePlanSqlQueries({
      prompt: params.prompt,
      sessionId,
      evidence,
      sqlQueries: plan.sqlQueries,
      allowedTeamIds,
      isAdmin: params.caller.isAdmin,
      stepOffset: 100,
      schemaCatalogText,
      accessibleTeams: accessibleTeams.map((team) => ({ id: team.id, name: team.name })),
      usage,
    });

    if (plan.documentSearches.length > 0) {
      await reportProgress(params.onProgress, "reviewing_documents", describeDocumentProgress(plan.documentSearches));
    }
    await executePlanSearches({
      sessionId,
      evidence,
      searches: plan.documentSearches,
      preferredTeamId: allowedTeamIds[0] ?? null,
    });
    usage.fileSearchCalls += plan.documentSearches.length;

    for (let round = 1; round <= 2; round += 1) {
      if (evidence.length === 0) break;
      await reportProgress(params.onProgress, "checking_gaps", "checking whether one more evidence step would help");
      const followUp = await decideAnalystFollowUp({
        prompt: params.prompt,
        plan,
        evidence,
        round,
      });
      accumulateUsage(usage, followUp.usage);
      if (!followUp.decision.needAnotherStep) break;

      const additionalPlan: AnalystPlan = {
        ...plan,
        sqlQueries: [],
        structuredTools: followUp.decision.nextTools as PlannerToolCall[],
        documentSearches: followUp.decision.nextDocumentSearches,
      };
      plan = additionalPlan;

      if (additionalPlan.structuredTools.length > 0) {
        await reportProgress(params.onProgress, "running_tools", describeToolProgress(additionalPlan.structuredTools));
      }
      await executePlanTools({
        sessionId,
        evidence,
        tools: additionalPlan.structuredTools,
        allowedTeamIds,
        stepOffset: round * 10,
        promptConstraints,
      });
      if (additionalPlan.documentSearches.length > 0) {
        await reportProgress(params.onProgress, "reviewing_documents", describeDocumentProgress(additionalPlan.documentSearches));
      }
      await executePlanSearches({
        sessionId,
        evidence,
        searches: additionalPlan.documentSearches,
        preferredTeamId: allowedTeamIds[0] ?? null,
      });
      usage.fileSearchCalls += additionalPlan.documentSearches.length;
    }

    const orgProfileText = evidence.find((item) => item.sourceKind === "org_profile")?.citationText ?? null;
    await reportProgress(params.onProgress, "writing_answer", "writing the final answer");
    const synthesized = await synthesizeAnalystAnswer({
      prompt: params.prompt,
      plan,
      orgProfile: orgProfileText,
      evidence,
      modelTier: plan.modelTier,
    });
    accumulateUsage(usage, synthesized.usage);

    const cost = estimateAnalysisCost({
      usage,
      modelTier: plan.modelTier,
    });

    const answer = formatSlackAnswer({
      answer: synthesized.answer.answer,
      evidenceBullets: synthesized.answer.evidenceBullets,
      whyItMatters: synthesized.answer.whyItMatters,
      confidenceLine: synthesized.answer.confidenceLine,
      estimatedCostUsd: cost.estimatedCostUsd,
      costTier: cost.costTier,
      modelTier: plan.modelTier,
    });

    await completeQuestionSession({
      sessionId,
      finalAnswer: answer.answer,
      confidenceLabel: answer.confidenceLine,
      modelTier: answer.modelTier,
      costTier: answer.costTier,
      estimatedCostUsd: answer.estimatedCostUsd,
      usage: usage as unknown as Record<string, unknown>,
    });

    const cacheable = !plan.needsWeb && (plan.route === "org_profile" || plan.route === "casual" || plan.route === "finance");
    if (cacheable) {
      await upsertAnswerCache({
        cacheKey,
        answerJson: answer as unknown as Record<string, unknown>,
        sourceVersionKey: contextVersion,
        expiresAt: new Date(Date.now() + 6 * 3600_000).toISOString(),
      });
    }

    return answer;
  } catch (error) {
    await failQuestionSession(sessionId, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

async function executePlanTools(params: {
  sessionId: string;
  evidence: AnalystEvidence[];
  tools: PlannerToolCall[];
  allowedTeamIds: string[];
  stepOffset: number;
  promptConstraints: { days?: number };
}) {
  const cappedTools = params.tools.slice(0, 6);
  for (let index = 0; index < cappedTools.length; index += 1) {
    const toolCall = cappedTools[index];
    const startedAt = Date.now();
    const parsedParams = applyPromptConstraints(parseToolParams(toolCall.paramsJson), params.promptConstraints);
    const output = await runStructuredTool(toolCall.tool, parsedParams, params.allowedTeamIds);
    const durationMs = Date.now() - startedAt;

    await recordQuestionToolCall({
      sessionId: params.sessionId,
      stepIndex: params.stepOffset + index,
      toolName: toolCall.tool,
      inputJson: parsedParams,
      outputJson: { data: output },
      durationMs,
    });

    const citationText = compactToolOutput(toolCall.tool, output);
    params.evidence.push({
      sourceKind: "structured_tool",
      title: toolCall.tool,
      citationText,
    });
    await addQuestionEvidence({
      sessionId: params.sessionId,
      sourceKind: "structured_tool",
      title: toolCall.tool,
      citationText,
      metadata: { rationale: toolCall.rationale },
    });
  }
}

async function executePlanSearches(params: {
  sessionId: string;
  evidence: AnalystEvidence[];
  searches: AnalystPlan["documentSearches"];
  preferredTeamId: string | null;
}) {
  const cappedSearches = params.searches.slice(0, 2);
  for (const search of cappedSearches) {
    const corpora: Array<"org" | "internal"> = search.corpus === "both" ? ["org", "internal"] : [search.corpus];
    for (const corpus of corpora) {
      const rows = await searchContextForQuestion({
        query: search.query,
        corpus,
        tags: search.tags,
        teamId: params.preferredTeamId,
        limit: search.limit,
      });

      for (const row of rows.slice(0, search.limit)) {
        const citationText = row.content_summary || row.content_text?.slice(0, 300) || "Indexed context source.";
        params.evidence.push({
          sourceKind: "context_source",
          title: row.title,
          citationText,
          sourceRef: row.source_url ?? row.id,
          metadata: { tags: row.tags, corpus: row.corpus },
        });
        await addQuestionEvidence({
          sessionId: params.sessionId,
          sourceKind: "context_source",
          sourceRef: row.source_url ?? row.id,
          title: row.title,
          citationText,
          metadata: { tags: row.tags, corpus: row.corpus },
        });
      }
    }
  }
}

async function executePlanSqlQueries(params: {
  prompt: string;
  sessionId: string;
  evidence: AnalystEvidence[];
  sqlQueries: AnalystPlan["sqlQueries"];
  allowedTeamIds: string[];
  isAdmin: boolean;
  stepOffset: number;
  schemaCatalogText: string;
  accessibleTeams: Array<{ id: string; name: string }>;
  usage: UsageTotals;
}) {
  const cappedQueries = params.sqlQueries.slice(0, 3);
  for (let index = 0; index < cappedQueries.length; index += 1) {
    const query = cappedQueries[index];
    try {
      const result = await validateAndExecuteSql({
        sessionId: params.sessionId,
        stepIndex: params.stepOffset + index,
        rationale: query.rationale,
        sql: query.sql,
        isAdmin: params.isAdmin,
        allowedTeamIds: params.allowedTeamIds,
      });

      const citationText = compactSqlRows(result.rows);
      params.evidence.push({
        sourceKind: "structured_tool",
        title: `SQL: ${query.expectedAnswerUse}`,
        citationText,
        metadata: {
          referencedTables: result.referencedTables,
          sqlFingerprint: result.sqlFingerprint,
        },
      });
      await addQuestionEvidence({
        sessionId: params.sessionId,
        sourceKind: "structured_tool",
        title: `SQL: ${query.expectedAnswerUse}`,
        citationText,
        metadata: {
          referencedTables: result.referencedTables,
          sqlFingerprint: result.sqlFingerprint,
          executedSql: result.executedSql,
        },
      });
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);

      try {
        const repaired = await repairAnalystSql({
          prompt: params.prompt,
          sql: query.sql,
          errorText,
          schemaCatalogText: params.schemaCatalogText,
          accessibleTeams: params.accessibleTeams,
        });
        accumulateUsage(params.usage, repaired.usage);

        const repairedResult = await validateAndExecuteSql({
          sessionId: params.sessionId,
          stepIndex: params.stepOffset + index,
          rationale: `${query.rationale} (repaired)`,
          sql: repaired.repair.sql,
          isAdmin: params.isAdmin,
          allowedTeamIds: params.allowedTeamIds,
        });

        const repairedCitationText = compactSqlRows(repairedResult.rows);
        params.evidence.push({
          sourceKind: "structured_tool",
          title: `SQL: ${query.expectedAnswerUse}`,
          citationText: repairedCitationText,
          metadata: {
            referencedTables: repairedResult.referencedTables,
            sqlFingerprint: repairedResult.sqlFingerprint,
            repairedFromError: errorText,
            repairRationale: repaired.repair.rationale,
          },
        });
        await addQuestionEvidence({
          sessionId: params.sessionId,
          sourceKind: "structured_tool",
          title: `SQL: ${query.expectedAnswerUse}`,
          citationText: repairedCitationText,
          metadata: {
            referencedTables: repairedResult.referencedTables,
            sqlFingerprint: repairedResult.sqlFingerprint,
            executedSql: repairedResult.executedSql,
            repairedFromError: errorText,
            repairRationale: repaired.repair.rationale,
          },
        });
        continue;
      } catch {}

      const fallback = chooseSqlFallback(query);
      if (!fallback) throw error;

      const output = await runStructuredTool(fallback.tool, fallback.params, params.allowedTeamIds);
      const citationText = compactToolOutput(fallback.tool, output);
      params.evidence.push({
        sourceKind: "structured_tool",
        title: `Fallback: ${fallback.tool}`,
        citationText,
        metadata: {
          fallbackForSql: query.expectedAnswerUse,
          sqlError: errorText,
        },
      });
      await addQuestionEvidence({
        sessionId: params.sessionId,
        sourceKind: "structured_tool",
        title: `Fallback: ${fallback.tool}`,
        citationText,
        metadata: {
          fallbackForSql: query.expectedAnswerUse,
          sqlError: errorText,
        },
      });
    }
  }
}

function chooseSqlFallback(query: AnalystPlan["sqlQueries"][number]) {
  const hint = `${query.rationale} ${query.expectedAnswerUse} ${query.sql}`.toLowerCase();

  if (
    hint.includes("team_roster_members") ||
    hint.includes("team size") ||
    hint.includes("member count") ||
    hint.includes("roster") ||
    hint.includes("how many")
  ) {
    return {
      tool: "get_team_directory" as const,
      params: {},
    };
  }

  if (hint.includes("purchase_logs") || hint.includes("purchase") || hint.includes("expense")) {
    return {
      tool: "get_purchase_log_rows" as const,
      params: { limit: 20 },
    };
  }

  if (hint.includes("vendor")) {
    return {
      tool: "get_vendor_summary" as const,
      params: {},
    };
  }

  return null;
}

async function runStructuredTool(tool: ToolName, params: Record<string, unknown>, allowedTeamIds: string[]) {
  const requestedTeamIds = sanitizeTeamIds(params.teamIds, allowedTeamIds);
  const teamIds = requestedTeamIds.length > 0 ? requestedTeamIds : allowedTeamIds;
  const days = typeof params.days === "number" ? Math.max(1, Math.min(365, Math.round(params.days))) : 120;
  const limit = typeof params.limit === "number" ? Math.max(1, Math.min(50, Math.round(params.limit))) : 20;
  const search = typeof params.search === "string" ? params.search : undefined;
  const tags = Array.isArray(params.tags) ? params.tags.filter((tag): tag is string => typeof tag === "string") : undefined;

  switch (tool) {
    case "get_org_profile":
      return { profile: await getCachedOrgProfile() };
    case "get_team_directory":
      return { rows: await getTeamDirectory(teamIds) };
    case "get_team_spend_summary":
      return { rows: await getTeamSpendSummary({ teamIds, days }) };
    case "get_purchase_log_rows":
      return { rows: await getPurchaseLogs({ teamIds, days, limit, search }) };
    case "get_vendor_summary":
      return { rows: await getVendorSummary({ teamIds, days }) };
    case "get_budget_vs_actual":
      return { rows: await getBudgetVsActual({ teamIds, days }) };
    case "get_receipt_anomalies":
      return { rows: await detectReceiptAuditRisks({ teamIds, days }) };
    case "get_recent_reports":
      return await getRecentReports();
    case "search_context_metadata":
      {
        const corpus =
          typeof params.corpus === "string" && (params.corpus === "org" || params.corpus === "internal")
            ? params.corpus
            : undefined;
        return {
          rows: await searchContextSources({
            query: search || "ssr",
            corpus,
            tags,
            teamId: teamIds[0] ?? null,
            limit,
          }),
        };
      }
    case "compare_team_spend_patterns":
      return { rows: await compareTeamSpendPatterns({ teamIds, days }) };
    case "rank_teams_by_fundraising_fit":
      return { rows: await rankTeamsByFundraisingFit({ teamIds, tags }) };
    case "summarize_reporting_health":
      return { rows: await summarizeReportingHealth({ teamIds, days }) };
    case "detect_receipt_audit_risks":
      return { rows: await detectReceiptAuditRisks({ teamIds, days }) };
    case "summarize_vendor_concentration":
      return { rows: await summarizeVendorConcentration({ teamIds, days }) };
    case "find_budget_pressure_signals":
      return { rows: await findBudgetPressureSignals({ teamIds, days }) };
    default:
      return { rows: [], note: `Unsupported tool ${tool}` };
  }
}

function compactToolOutput(toolName: string, output: unknown) {
  if (toolName === "get_team_directory") {
    const rows = (output as { rows?: Array<{ name?: string; active_member_count?: number }> }).rows ?? [];
    if (rows.length > 0) {
      return rows
        .map((row) => `${row.name || "Unknown team"}: ${row.active_member_count ?? 0} active members`)
        .join("; ");
    }
  }

  if (toolName === "get_team_spend_summary" || toolName === "compare_team_spend_patterns") {
    const rows =
      (output as {
        rows?: Array<{ teamId?: string; totalCents?: number; count?: number; shareOfSpend?: number; averageCents?: number }>;
      }).rows ?? [];
    if (rows.length > 0) {
      return rows
        .map((row) => {
          const total = typeof row.totalCents === "number" ? `$${(row.totalCents / 100).toFixed(2)}` : "unknown total";
          const count = typeof row.count === "number" ? `${row.count} purchases` : "unknown purchase count";
          return `${row.teamId || "Unknown team"}: ${total}, ${count}`;
        })
        .join("; ");
    }
  }

  if (toolName === "get_purchase_log_rows") {
    const rows =
      (output as {
        rows?: Array<{
          id?: string;
          team_id?: string;
          amount_cents?: number;
          description?: string;
          purchased_at?: string;
          person_name?: string | null;
          payment_method?: string | null;
          category?: string | null;
          receipt_not_needed?: boolean | null;
        }>;
      }).rows ?? [];
    if (rows.length > 0) {
      return rows
        .slice(0, 20)
        .map((row) => {
          const amount = typeof row.amount_cents === "number" ? `$${(row.amount_cents / 100).toFixed(2)}` : "unknown amount";
          const date = row.purchased_at ? row.purchased_at.slice(0, 10) : "unknown date";
          const description = (row.description || "Unknown purchase").slice(0, 80);
          return `${date} | ${description} | ${amount} | team ${row.team_id || "unknown"}`;
        })
        .join("; ");
    }
  }

  if (toolName === "get_vendor_summary" || toolName === "summarize_vendor_concentration") {
    const rows = (output as { rows?: Array<{ vendor?: string; totalCents?: number; count?: number; shareOfSpend?: number }> }).rows ?? [];
    if (rows.length > 0) {
      return rows
        .slice(0, 10)
        .map((row) => {
          const total = typeof row.totalCents === "number" ? `$${(row.totalCents / 100).toFixed(2)}` : "unknown total";
          return `${row.vendor || "Unknown vendor"}: ${total}`;
        })
        .join("; ");
    }
  }

  const json = JSON.stringify(output);
  return `${toolName}: ${json.slice(0, 500)}`;
}

function compactSqlRows(rows: Array<Record<string, unknown>>) {
  if (rows.length === 0) {
    return "Query returned no rows.";
  }
  return rows
    .slice(0, 8)
    .map((row) =>
      Object.entries(row)
        .slice(0, 6)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(", "),
    )
    .join("; ");
}

function sanitizeTeamIds(input: unknown, allowedTeamIds: string[]) {
  const requested = Array.isArray(input) ? input.filter((item): item is string => typeof item === "string") : [];
  return requested.filter((teamId) => allowedTeamIds.includes(teamId));
}

function parseToolParams(paramsJson: string) {
  try {
    const parsed = JSON.parse(paramsJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {}
  return {};
}

function inferPromptConstraints(prompt: string) {
  const lower = prompt.toLowerCase();
  const explicitDays = lower.match(/last\s+(\d{1,3})\s+days?/);
  if (explicitDays) {
    return { days: Number(explicitDays[1]) };
  }
  if (/\blast quarter\b/.test(lower)) return { days: 90 };
  if (/\blast month\b/.test(lower)) return { days: 30 };
  if (/\blast year\b/.test(lower)) return { days: 365 };
  return {};
}

function applyPromptConstraints(params: Record<string, unknown>, constraints: { days?: number }) {
  const next = { ...params };
  if (next.days == null && constraints.days != null) {
    next.days = constraints.days;
  }
  return next;
}

function normalizePrompt(prompt: string) {
  return prompt.toLowerCase().replace(/\s+/g, " ").trim();
}

function matchTeamFromPrompt(normalizedPrompt: string, teams: Array<{ id: string; name: string }>) {
  const compactPrompt = normalizedPrompt.replace(/[^a-z0-9]/g, "");
  return (
    teams.find((team) => normalizedPrompt.includes(team.name.toLowerCase())) ??
    teams.find((team) => compactPrompt.includes(team.name.toLowerCase().replace(/[^a-z0-9]/g, ""))) ??
    null
  );
}

function isTeamSizeQuestion(normalizedPrompt: string) {
  return /(how many|# of|number of).*(people|ppl|members|students)/.test(normalizedPrompt);
}

function isMonthlySpendQuestion(normalizedPrompt: string) {
  return /(monthly|per month|each month|by month).*(spend|spent|expenses|purchases|total)/.test(normalizedPrompt)
    || /(spend|spent|expenses|purchases|total).*(monthly|per month|each month|by month)/.test(normalizedPrompt);
}

function isClubWideQuestion(normalizedPrompt: string) {
  return /(ssr|club|overall|all teams|whole club|organization|org-wide|org wide|total club)/.test(normalizedPrompt);
}

function looksLikeClubMonthlySpendQuestion(normalizedPrompt: string) {
  const hasClubScope = isClubWideQuestion(normalizedPrompt);
  const hasSpendIntent = /(spend|spent|expenses|purchases|total)/.test(normalizedPrompt);
  const hasMonthIntent = /(monthly|montly|monthy|montjly|per month|each month|by month|month)/.test(normalizedPrompt);
  return hasClubScope && hasSpendIntent && hasMonthIntent;
}

function looksLikeBiggestPurchasesQuestion(normalizedPrompt: string) {
  const hasPurchaseIntent = /(purchase|purchases|expense|expenses|spent)/.test(normalizedPrompt);
  const hasRankingIntent = /(biggest|largest|top|highest|big|major)/.test(normalizedPrompt);
  return hasPurchaseIntent && hasRankingIntent;
}

function looksLikePurchaseCountQuestion(normalizedPrompt: string) {
  return /(how many|number of|count).*(purchase|purchases)/.test(normalizedPrompt)
    || /(purchase|purchases).*(how many|number of|count)/.test(normalizedPrompt);
}

function looksLikeStructuredDataQuestion(normalizedPrompt: string) {
  return /(purchase|purchases|expense|expenses|spent|spend|budget|budgets|report|reports|vendor|vendors|receipt|receipts|team|teams|member|members|roster|count|counts|category|categories|monthly|month|year|finance|financial|audit)/.test(
    normalizedPrompt,
  );
}

function isCategorySplitQuestion(normalizedPrompt: string) {
  return /(split by category|by category|category of expense|expense category|categories)/.test(normalizedPrompt);
}

function isPerPersonQuestion(normalizedPrompt: string) {
  return /(per person|per member|on average|average per person|divide by member count|divide by roster)/.test(normalizedPrompt);
}

function inferMonthlyStartDate(prompt: string) {
  const lower = prompt.toLowerCase();
  const iso = lower.match(/\b(20\d{2})-(\d{2})(?:-(\d{2}))?\b/);
  if (iso) {
    return `${iso[1]}-${iso[2]}-${iso[3] ?? "01"}`;
  }

  const monthMap: Record<string, string> = {
    january: "01",
    jan: "01",
    february: "02",
    feb: "02",
    march: "03",
    mar: "03",
    april: "04",
    apr: "04",
    may: "05",
    june: "06",
    jun: "06",
    july: "07",
    jul: "07",
    august: "08",
    aug: "08",
    september: "09",
    sep: "09",
    october: "10",
    oct: "10",
    november: "11",
    nov: "11",
    december: "12",
    dec: "12",
  };

  const lastMonthYear = lower.match(/\blast\s+(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sep|october|oct|november|nov|december|dec)\b/);
  if (lastMonthYear) {
    const now = new Date();
    const currentYear = now.getUTCFullYear();
    const currentMonth = now.getUTCMonth() + 1;
    const monthValue = Number(monthMap[lastMonthYear[1]]);
    const year = monthValue <= currentMonth ? currentYear - 1 : currentYear;
    return `${year}-${monthMap[lastMonthYear[1]]}-01`;
  }

  const bareMonth = lower.match(/\bsince\s+(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sep|october|oct|november|nov|december|dec)\b/);
  if (bareMonth) {
    const now = new Date();
    const currentYear = now.getUTCFullYear();
    const currentMonth = now.getUTCMonth() + 1;
    const monthValue = Number(monthMap[bareMonth[1]]);
    const year = monthValue <= currentMonth ? currentYear : currentYear - 1;
    return `${year}-${monthMap[bareMonth[1]]}-01`;
  }

  const monthYear = lower.match(/\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sep|october|oct|november|nov|december|dec)\s+(20\d{2})\b/);
  if (!monthYear) return null;

  return `${monthYear[2]}-${monthMap[monthYear[1]]}-01`;
}

function inferYearStartDate(prompt: string) {
  const lower = prompt.toLowerCase();
  const now = new Date();

  if (/\bthis year\b|\bthis yesr\b|\bthis yr\b/.test(lower)) {
    return `${now.getUTCFullYear()}-01-01`;
  }
  if (/\blast year\b/.test(lower)) {
    return `${now.getUTCFullYear() - 1}-01-01`;
  }

  const explicitYear = lower.match(/\b(20\d{2})\b/);
  if (explicitYear) {
    return `${explicitYear[1]}-01-01`;
  }

  return null;
}

function inferStartDateFromPromptOrHistory(prompt: string, historyText: string) {
  return (
    inferMonthlyStartDate(prompt)
    ?? inferYearStartDate(prompt)
    ?? inferMonthlyStartDate(historyText)
    ?? inferYearStartDate(historyText)
  );
}

function shouldInheritClubMonthlySpendContext(normalizedPrompt: string, historyText: string) {
  const priorClubMonthlySpend = /(total club spend per month|club spend per month|total club spend per person per month|club monthly spend)/.test(historyText);
  const promptLooksLikeCorrection = /(include|including|also|as well|asw|redo|fix|correct|supposed to|do it|202\d{2}|this year|last year|since)/.test(normalizedPrompt);
  return priorClubMonthlySpend && promptLooksLikeCorrection;
}

function buildMonthRange(startDate: string, endDate: Date) {
  const start = new Date(`${startDate.slice(0, 7)}-01T00:00:00.000Z`);
  const end = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), 1));
  const months: string[] = [];
  const cursor = new Date(start);

  while (cursor <= end) {
    months.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  return months;
}

function accumulateUsage(usage: UsageTotals, increment: { inputTokens: number; outputTokens: number }) {
  usage.inputTokens += increment.inputTokens;
  usage.outputTokens += increment.outputTokens;
}

function formatSlackAnswer(params: AnalystAnswer): AnalystAnswer {
  const parts = [params.answer.trim()];

  if (params.evidenceBullets.length > 0) {
    parts.push(["Evidence:", ...params.evidenceBullets.map((bullet) => `• ${bullet}`)].join("\n"));
  }
  if (params.whyItMatters) {
    parts.push(`Why this matters: ${params.whyItMatters}`);
  }
  parts.push(params.confidenceLine);
  parts.push(`Estimated cost: ${params.costTier} (~$${params.estimatedCostUsd.toFixed(3)})`);

  return {
    ...params,
    answer: parts.join("\n\n"),
  };
}

function shouldUseLightweightReply(normalizedPrompt: string) {
  return LIGHTWEIGHT_PATTERNS.some((pattern) => pattern.test(normalizedPrompt));
}

async function tryDirectSqlAnswer(params: {
  sessionId: string;
  prompt: string;
  history: Array<{ speaker: string; text: string }>;
  accessibleTeams: Array<{ id: string; name: string }>;
  allowedTeamIds: string[];
  isAdmin: boolean;
  schemaCatalogText: string;
  usage: UsageTotals;
  onProgress?: (stage: AnalystProgressStage, detail: string) => Promise<void> | void;
}) {
  if (!looksLikeStructuredDataQuestion(normalizePrompt(params.prompt))) {
    return null;
  }

  await reportProgress(params.onProgress, "running_tools", "checking schema for relevant tables");
  const directPlan = await planDirectSqlQuestion({
    prompt: params.prompt,
    history: params.history,
    accessibleTeams: params.accessibleTeams,
    schemaCatalogText: params.schemaCatalogText,
  });
  accumulateUsage(params.usage, directPlan.usage);

  if (!directPlan.plan.shouldUseDirectSql || !directPlan.plan.sql.trim()) {
    return null;
  }

  const sqlPlan = {
    rationale: directPlan.plan.rationale,
    sql: directPlan.plan.sql,
    expectedAnswerUse: directPlan.plan.expectedAnswerUse,
  };

  await reportProgress(params.onProgress, "running_tools", "running finance queries");
  let sqlResult;
  try {
    sqlResult = await validateAndExecuteSql({
      sessionId: params.sessionId,
      stepIndex: 900,
      rationale: sqlPlan.rationale,
      sql: sqlPlan.sql,
      isAdmin: params.isAdmin,
      allowedTeamIds: params.allowedTeamIds,
    });
  } catch (error) {
    try {
      const repaired = await repairAnalystSql({
        prompt: params.prompt,
        sql: sqlPlan.sql,
        errorText: error instanceof Error ? error.message : String(error),
        schemaCatalogText: params.schemaCatalogText,
        accessibleTeams: params.accessibleTeams,
      });
      accumulateUsage(params.usage, repaired.usage);
      sqlResult = await validateAndExecuteSql({
        sessionId: params.sessionId,
        stepIndex: 901,
        rationale: `${sqlPlan.rationale} (repaired)`,
        sql: repaired.repair.sql,
        isAdmin: params.isAdmin,
        allowedTeamIds: params.allowedTeamIds,
      });
    } catch {
      return null;
    }
  }

  const evidence: AnalystEvidence[] = [
    {
      sourceKind: "structured_tool",
      title: `SQL: ${sqlPlan.expectedAnswerUse}`,
      citationText: compactSqlRows(sqlResult.rows),
      metadata: {
        referencedTables: sqlResult.referencedTables,
        sqlFingerprint: sqlResult.sqlFingerprint,
      },
    },
  ];
  await addQuestionEvidence({
    sessionId: params.sessionId,
    sourceKind: "structured_tool",
    title: `SQL: ${sqlPlan.expectedAnswerUse}`,
    citationText: compactSqlRows(sqlResult.rows),
    metadata: {
      referencedTables: sqlResult.referencedTables,
      sqlFingerprint: sqlResult.sqlFingerprint,
      executedSql: sqlResult.executedSql,
      directSql: true,
    },
  });

  await reportProgress(params.onProgress, "writing_answer", "writing the final answer");
  const synthesized = await synthesizeAnalystAnswer({
    prompt: params.prompt,
    plan: {
      route: "finance",
      answerCasually: false,
      modelTier: "deep",
      subquestions: [],
      needsOrgProfile: false,
      needsStructuredData: true,
      needsDocuments: false,
      needsWeb: false,
      structuredTools: [],
      sqlQueries: [sqlPlan],
      documentSearches: [],
    },
    orgProfile: null,
    evidence,
    modelTier: "deep",
  });
  accumulateUsage(params.usage, synthesized.usage);

  const cost = estimateAnalysisCost({
    usage: params.usage,
    modelTier: "deep",
  });

  return formatSlackAnswer({
    answer: synthesized.answer.answer,
    evidenceBullets: synthesized.answer.evidenceBullets,
    whyItMatters: synthesized.answer.whyItMatters,
    confidenceLine: synthesized.answer.confidenceLine,
    estimatedCostUsd: cost.estimatedCostUsd,
    costTier: cost.costTier,
    modelTier: "deep",
  });
}

async function maybeHandleDeterministicPrompt(params: {
  prompt: string;
  normalizedPrompt: string;
  accessibleTeams: Array<{ id: string; name: string }>;
  history: Array<{ speaker: string; text: string }>;
}) {
  const historyText = params.history.map((item) => item.text.toLowerCase()).join("\n");
  const startDateFromContext = inferStartDateFromPromptOrHistory(params.prompt, historyText);
  const inheritsClubMonthlySpendContext = shouldInheritClubMonthlySpendContext(params.normalizedPrompt, historyText);

  if (isCategorySplitQuestion(params.normalizedPrompt) && /club spend per month|total club spend per month/.test(historyText)) {
    const rows = await getMonthlySpendByCategoryForTeams({
      teamIds: params.accessibleTeams.map((team) => team.id),
      startDate: startDateFromContext,
    });
    const months = buildMonthRange(
      startDateFromContext ?? `${rows[0]?.month ?? new Date().toISOString().slice(0, 7)}-01`,
      new Date(),
    );
    const byMonth = new Map<string, Array<{ category: string; totalCents: number }>>();
    for (const row of rows) {
      const current = byMonth.get(row.month) ?? [];
      current.push({ category: row.category, totalCents: row.totalCents });
      byMonth.set(row.month, current.sort((a, b) => b.totalCents - a.totalCents));
    }

    return formatSlackAnswer({
      answer: [
        "Total club spend per month by category:",
        ...months.map((month) => {
          const categories = byMonth.get(month) ?? [];
          if (categories.length === 0) return `• ${month}: $0.00`;
          return `• ${month}: ${categories.map((row) => `${row.category} $${(row.totalCents / 100).toFixed(2)}`).join(", ")}`;
        }),
      ].join("\n"),
      evidenceBullets: [
        `Grouped \`purchase_logs.amount_cents\` by month and \`purchase_logs.category\` across ${params.accessibleTeams.length} accessible teams.`,
        startDateFromContext ? `Applied start-date filter from ${startDateFromContext.slice(0, 10)} onward.` : "Included months through the current month.",
      ],
      whyItMatters: null,
      confidenceLine: "Confidence: High for logged purchases because this is a direct aggregation over purchase dates and stored categories.",
      estimatedCostUsd: 0.001,
      costTier: "light",
      modelTier: "mini",
    });
  }

  if (looksLikePurchaseCountQuestion(params.normalizedPrompt) && /(per month|every month|each month|monthly|by month)/.test(params.normalizedPrompt) && isClubWideQuestion(params.normalizedPrompt)) {
    const startDate = startDateFromContext ?? inferYearStartDate(params.prompt);
    const rows = await getPurchaseCountsByMonthForTeams({
      teamIds: params.accessibleTeams.map((team) => team.id),
      startDate,
    });
    const months = buildMonthRange(
      startDate ?? `${rows[0]?.month ?? new Date().toISOString().slice(0, 7)}-01`,
      new Date(),
    );
    const countByMonth = new Map(rows.map((row) => [row.month, row.count]));

    return formatSlackAnswer({
      answer: [
        "SSR purchases per month:",
        ...months.map((month) => `• ${month}: ${countByMonth.get(month) ?? 0}`),
      ].join("\n"),
      evidenceBullets: [
        "Used an exact month-by-month count over `purchase_logs`, not a limited row fetch.",
        startDate ? `Applied start-date filter from ${startDate.slice(0, 10)} onward.` : "Included months through the current month.",
      ],
      whyItMatters: null,
      confidenceLine: "Confidence: High because this is a direct month-by-month count from the purchase log.",
      estimatedCostUsd: 0.001,
      costTier: "light",
      modelTier: "mini",
    });
  }

  if (looksLikePurchaseCountQuestion(params.normalizedPrompt) && isClubWideQuestion(params.normalizedPrompt)) {
    const startDate = startDateFromContext ?? inferYearStartDate(params.prompt);
    const count = await getPurchaseCountForTeams({
      teamIds: params.accessibleTeams.map((team) => team.id),
      startDate,
    });

    return formatSlackAnswer({
      answer: `${count} purchases${startDate ? ` since ${startDate.slice(0, 10)}` : ""} across the ${params.accessibleTeams.length} accessible SSR teams.`,
      evidenceBullets: [
        "Used an exact count over `purchase_logs`, not a limited row fetch.",
        startDate ? `Applied start-date filter from ${startDate.slice(0, 10)} onward.` : "Used all available logged purchases.",
      ],
      whyItMatters: null,
      confidenceLine: "Confidence: High because this is a direct exact count from the purchase log.",
      estimatedCostUsd: 0.001,
      costTier: "light",
      modelTier: "mini",
    });
  }

  if (looksLikeBiggestPurchasesQuestion(params.normalizedPrompt) && isClubWideQuestion(params.normalizedPrompt)) {
    const startDate = inferYearStartDate(params.prompt);
    const rows = await getTopPurchasesForTeams({
      teamIds: params.accessibleTeams.map((team) => team.id),
      startDate,
      limit: 8,
    });

    return formatSlackAnswer({
      answer:
        rows.length === 0
          ? `I don’t see any logged club purchases${startDate ? ` since ${startDate.slice(0, 10)}` : ""}.`
          : [
              `Biggest club purchases${startDate ? ` since ${startDate.slice(0, 4)}` : ""}:`,
              ...rows.map((row) => {
                const amount = typeof row.amount_cents === "number" ? `$${(row.amount_cents / 100).toFixed(2)}` : "$0.00";
                const date = typeof row.purchased_at === "string" ? row.purchased_at.slice(0, 10) : "unknown date";
                const description = typeof row.description === "string" && row.description.trim() ? row.description.trim() : "Unnamed purchase";
                return `• ${date} | ${description} | ${amount}`;
              }),
            ].join("\n"),
      evidenceBullets: [
        `Ranked \`purchase_logs\` by \`amount_cents\` across ${params.accessibleTeams.length} accessible teams.`,
        startDate ? `Applied start-date filter from ${startDate.slice(0, 10)} onward.` : "Used all available logged purchases.",
      ],
      whyItMatters: null,
      confidenceLine: "Confidence: High for logged purchases because this is a direct ranking from the purchase log.",
      estimatedCostUsd: 0.001,
      costTier: "light",
      modelTier: "mini",
    });
  }

  if (looksLikeClubMonthlySpendQuestion(params.normalizedPrompt) || inheritsClubMonthlySpendContext) {
    const startDate = startDateFromContext;
    const spendRows = await getMonthlySpendForTeams({
      teamIds: params.accessibleTeams.map((team) => team.id),
      startDate,
    });
    const months = buildMonthRange(
      startDate ?? `${spendRows[0]?.month ?? new Date().toISOString().slice(0, 7)}-01`,
      new Date(),
    );
    const perPerson = isPerPersonQuestion(params.normalizedPrompt) || (inheritsClubMonthlySpendContext && isPerPersonQuestion(historyText));
    const spendByMonth = new Map(spendRows.map((row) => [row.month, row.totalCents]));
    const memberCounts = perPerson
      ? await getMonthlyMemberCountsForTeams({
          teamIds: params.accessibleTeams.map((team) => team.id),
          months,
        })
      : null;
    const memberCountByMonth = new Map(memberCounts?.counts.map((row) => [row.month, row.memberCount]) ?? []);

    return formatSlackAnswer({
      answer: [
        perPerson ? "Total club spend per person per month:" : "Total club spend per month:",
        ...months.map((month) => {
          const totalCents = spendByMonth.get(month) ?? 0;
          if (!perPerson) {
            return `• ${month}: $${(totalCents / 100).toFixed(2)}`;
          }
          const members = Math.max(1, memberCountByMonth.get(month) ?? 1);
          return `• ${month}: $${(totalCents / 100).toFixed(2)} total, $${(totalCents / 100 / members).toFixed(2)} per person (${members} members)`;
        }),
      ].join("\n"),
      evidenceBullets: [
        `Summed \`purchase_logs.amount_cents\` by month using \`purchase_logs.purchased_at\` across ${params.accessibleTeams.length} accessible teams.`,
        perPerson
          ? memberCounts?.method === "historical_roster"
            ? "Estimated each month's divisor from historical `team_roster_members` join/leave dates across the accessible teams."
            : memberCounts?.method === "joined_only"
              ? "Estimated each month's divisor from `team_roster_members` join dates across the accessible teams; no leave-date field was available."
              : "Used current `team_roster_members` counts for each month because no historical roster date field was available."
          : "Reported raw monthly totals only.",
        startDate ? `Applied start-date filter from ${startDate.slice(0, 10)} onward.` : "Included months through the current month.",
      ],
      whyItMatters: null,
      confidenceLine: perPerson
        ? "Confidence: High for spend totals; member-count confidence depends on the historical roster fields available in `team_roster_members`."
        : "Confidence: High for logged purchases because this is a direct aggregation over purchase dates.",
      estimatedCostUsd: 0.001,
      costTier: "light",
      modelTier: "mini",
    });
  }

  const matchedTeam = matchTeamFromPrompt(params.normalizedPrompt, params.accessibleTeams);
  if (!matchedTeam) return null;

  if (isTeamSizeQuestion(params.normalizedPrompt)) {
    const rows = await getTeamDirectory([matchedTeam.id]);
    const team = rows[0];
    const count = team?.active_member_count ?? 0;
    return formatSlackAnswer({
      answer: `${matchedTeam.name} has ${count} rostered member${count === 1 ? "" : "s"}.`,
      evidenceBullets: [`Counted ${count} row${count === 1 ? "" : "s"} in \`public.team_roster_members\` for ${matchedTeam.name}.`],
      whyItMatters: null,
      confidenceLine: "Confidence: High.",
      estimatedCostUsd: 0.001,
      costTier: "light",
      modelTier: "mini",
    });
  }

  if (isMonthlySpendQuestion(params.normalizedPrompt)) {
    const startDate = inferMonthlyStartDate(params.prompt);
    const spendRows = await getTeamMonthlySpend({
      teamId: matchedTeam.id,
      startDate,
    });
    const months = buildMonthRange(
      startDate ?? `${spendRows[0]?.month ?? new Date().toISOString().slice(0, 7)}-01`,
      new Date(),
    );
    const perPerson = isPerPersonQuestion(params.normalizedPrompt);
    const spendByMonth = new Map(spendRows.map((row) => [row.month, row.totalCents]));
    const memberCounts = perPerson
      ? await getTeamMonthlyMemberCounts({
          teamId: matchedTeam.id,
          months,
        })
      : null;
    const memberCountByMonth = new Map(memberCounts?.counts.map((row) => [row.month, row.memberCount]) ?? []);

    const answer =
      spendRows.length === 0
        ? `I don’t see any logged purchases for ${matchedTeam.name}${startDate ? ` since ${startDate.slice(0, 7)}` : ""}.`
        : [
            perPerson ? `${matchedTeam.name} monthly spend per person:` : `${matchedTeam.name} monthly spend:`,
            ...months.map((month) => {
              const totalCents = spendByMonth.get(month) ?? 0;
              if (!perPerson) {
                return `• ${month}: $${(totalCents / 100).toFixed(2)}`;
              }
              const members = Math.max(1, memberCountByMonth.get(month) ?? 1);
              return `• ${month}: $${(totalCents / 100).toFixed(2)} total, $${(totalCents / 100 / members).toFixed(2)} per person (${members} members)`;
            }),
          ].join("\n");

    return formatSlackAnswer({
      answer,
      evidenceBullets: [
        `Summed \`purchase_logs.amount_cents\` by month using \`purchase_logs.purchased_at\` for ${matchedTeam.name}.`,
        perPerson
          ? memberCounts?.method === "historical_roster"
            ? "Estimated each month's divisor from historical `team_roster_members` join/leave dates."
            : memberCounts?.method === "joined_only"
              ? "Estimated each month's divisor from `team_roster_members` join dates; no leave-date field was available."
              : "Used the current `team_roster_members` count for each month because no historical roster date field was available."
          : "Reported raw monthly totals only.",
        startDate ? `Applied start-date filter from ${startDate.slice(0, 10)} onward.` : "Included months through the current month.",
      ],
      whyItMatters: null,
      confidenceLine: perPerson
        ? "Confidence: High for spend totals; member-count confidence depends on the historical roster fields available in `team_roster_members`."
        : "Confidence: High for logged purchases because this is a direct aggregation over purchase dates.",
      estimatedCostUsd: 0.001,
      costTier: "light",
      modelTier: "mini",
    });
  }

  return null;
}

async function reportProgress(
  onProgress: ((stage: AnalystProgressStage, detail: string) => Promise<void> | void) | undefined,
  stage: AnalystProgressStage,
  detail: string,
) {
  if (!onProgress) return;
  await onProgress(stage, detail);
}

function describeToolProgress(tools: PlannerToolCall[]) {
  const names = tools.slice(0, 2).map((tool) => humanizeToolName(tool.tool));
  if (names.length === 0) return "checking structured SSR data";
  return `checking ${names.join(" and ")}`;
}

function describeDocumentProgress(searches: AnalystPlan["documentSearches"]) {
  const first = searches[0];
  if (!first) return "reviewing indexed documents";
  const tagText = first.tags.slice(0, 2).join(", ");
  return tagText ? `reviewing ${tagText} documents` : "reviewing indexed documents";
}

function humanizeToolName(tool: ToolName) {
  switch (tool) {
    case "get_team_spend_summary":
    case "compare_team_spend_patterns":
      return "team spend patterns";
    case "get_purchase_log_rows":
    case "detect_receipt_audit_risks":
      return "purchase and audit records";
    case "get_vendor_summary":
    case "summarize_vendor_concentration":
      return "vendor concentration";
    case "find_budget_pressure_signals":
      return "budget pressure signals";
    case "get_org_profile":
      return "SSR org context";
    default:
      return tool.replace(/_/g, " ");
  }
}
