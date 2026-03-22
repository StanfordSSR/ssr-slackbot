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
  getPurchaseLogs,
  getRecentReports,
  getTeamDirectory,
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
import { decideAnalystFollowUp, estimateAnalysisCost, planAnalystQuestion, synthesizeAnalystAnswer, UsageTotals } from "@/lib/analyst-openai";
import { getCachedOrgProfile, searchContextForQuestion } from "@/lib/context-ingestion";
import { AnalystAnswer, AnalystEvidence, AnalystPlan, PlannerToolCall, ToolName } from "@/types/analyst";

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

  const accessibleTeams = await getAccessibleTeamScope(params.caller.profileId, params.caller.isAdmin);
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
    const planned = await planAnalystQuestion({
      prompt: params.prompt,
      history: params.history ?? [],
      accessibleTeams: accessibleTeams.map((team) => ({ id: team.id, name: team.name })),
    });
    accumulateUsage(usage, planned.usage);
    let plan = planned.plan;

    await updateQuestionSessionPlan(sessionId, plan.route, plan as unknown as Record<string, unknown>);

    const evidence: AnalystEvidence[] = [];
    const allowedTeamIds = accessibleTeams.map((team) => team.id);

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
}) {
  const cappedTools = params.tools.slice(0, 6);
  for (let index = 0; index < cappedTools.length; index += 1) {
    const toolCall = cappedTools[index];
    const startedAt = Date.now();
    const parsedParams = parseToolParams(toolCall.paramsJson);
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
  const json = JSON.stringify(output);
  return `${toolName}: ${json.slice(0, 500)}`;
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

function normalizePrompt(prompt: string) {
  return prompt.toLowerCase().replace(/\s+/g, " ").trim();
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
