import { getEnv } from "@/lib/env";
import {
  getPendingReimbursementPushIds,
  getReimbursementMessagesById,
  getReimbursementPushById,
  updateReimbursementPushStatus,
} from "@/lib/supabase";
import { reimbursementDecisionBlocks } from "@/lib/slack-blocks";
import { updateMessage } from "@/lib/slack";

export type ReimbursementDecision = "approved" | "rejected";
export type ReimbursementApprovalKind = "button" | "signature" | null;

export type HqReimbursementStatus = {
  id: string;
  status: "pending" | ReimbursementDecision;
  approval_kind: ReimbursementApprovalKind;
  decided_by_name: string | null;
  decided_at: string | null;
  finance_processed: boolean;
};

type HqDecisionResponse = {
  ok?: boolean;
  note?: string;
  status?: ReimbursementDecision;
  error?: string;
  approve_url?: string;
  decided_by_name?: string | null;
  approval_kind?: ReimbursementApprovalKind;
};

export function getNotifySharedSecret() {
  return getEnv("SSR_SLACKBOT_NOTIFY_SECRET") || getEnv("INTERNAL_NOTIFY_SHARED_SECRET");
}

export function getNotifySharedSecrets() {
  return [getEnv("SSR_SLACKBOT_NOTIFY_SECRET"), getEnv("INTERNAL_NOTIFY_SHARED_SECRET")]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
}

export function isValidNotifyBearer(authHeader: string | null) {
  return getNotifySharedSecrets().some((secret) => authHeader === `Bearer ${secret}`);
}

export function getHqBaseUrl() {
  return (getEnv("HQ_BASE_URL") || "https://hq.stanfordssr.org").replace(/\/+$/, "");
}

export function decodeReimbursementDecisionValue(value: string) {
  const separatorIndex = value.lastIndexOf(":");
  if (separatorIndex < 0) {
    const reimbursementId = value.trim();
    if (!reimbursementId) {
      throw new Error("Invalid reimbursement decision value.");
    }
    return { reimbursementId, decision: null };
  }

  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    throw new Error("Invalid reimbursement decision value.");
  }

  const reimbursementId = value.slice(0, separatorIndex);
  const decision = value.slice(separatorIndex + 1);
  if (decision !== "approved" && decision !== "rejected") {
    throw new Error("Invalid reimbursement decision.");
  }

  return { reimbursementId, decision: decision as ReimbursementDecision };
}

export async function submitReimbursementDecision(params: {
  reimbursementId: string;
  decision: ReimbursementDecision;
  approverEmail: string | null;
  approverSlackUserId: string;
}) {
  const secret = getNotifySharedSecret();
  if (!secret) {
    throw new Error("Missing SSR_SLACKBOT_NOTIFY_SECRET or INTERNAL_NOTIFY_SHARED_SECRET.");
  }

  const callbackPayload: {
    reimbursement_id: string;
    decision: ReimbursementDecision;
    approver_email?: string;
    approver_slack_user_id?: string;
  } = {
    reimbursement_id: params.reimbursementId,
    decision: params.decision,
  };

  if (params.approverEmail) {
    callbackPayload.approver_email = params.approverEmail;
  } else {
    callbackPayload.approver_slack_user_id = params.approverSlackUserId;
  }

  const response = await fetch(`${getHqBaseUrl()}/api/internal/reimbursement-approval`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(callbackPayload),
    cache: "no-store",
  });

  const rawBody = await response.text();
  let body: HqDecisionResponse | null = null;
  try {
    body = rawBody ? (JSON.parse(rawBody) as HqDecisionResponse) : null;
  } catch {
    body = null;
  }

  return {
    httpStatus: response.status,
    ok: response.ok,
    body,
    rawBody,
  };
}

export async function fetchReimbursementStatuses(reimbursementIds: string[]) {
  const ids = [...new Set(reimbursementIds.map((id) => id.trim()).filter(Boolean))].slice(0, 200);
  if (ids.length === 0) {
    return [];
  }

  const secret = getNotifySharedSecret();
  if (!secret) {
    throw new Error("Missing SSR_SLACKBOT_NOTIFY_SECRET or INTERNAL_NOTIFY_SHARED_SECRET.");
  }

  const url = new URL(`${getHqBaseUrl()}/api/internal/reimbursement-status`);
  url.searchParams.set("ids", ids.join(","));

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${secret}`,
    },
    cache: "no-store",
  });

  const rawBody = await response.text();
  let body: { ok?: boolean; results?: HqReimbursementStatus[]; error?: string } | null = null;
  try {
    body = rawBody ? (JSON.parse(rawBody) as { ok?: boolean; results?: HqReimbursementStatus[]; error?: string }) : null;
  } catch {
    body = null;
  }

  if (!response.ok || !body?.ok) {
    throw new Error(body?.error || rawBody.trim().slice(0, 300) || `HQ status request failed with ${response.status}`);
  }

  return body.results ?? [];
}

export async function syncReimbursementMessages(params: {
  reimbursementId: string;
  status: ReimbursementDecision;
  decidedByName: string | null;
  approvalKind?: ReimbursementApprovalKind;
}) {
  const push = await getReimbursementPushById(params.reimbursementId);
  const messages = await getReimbursementMessagesById(params.reimbursementId);
  const blocks = reimbursementDecisionBlocks({
    title: push?.title ?? null,
    message: push?.message ?? null,
    teamName: push?.team_name ?? null,
    status: params.status,
    decidedByName: params.decidedByName,
    approvalKind: params.approvalKind ?? null,
  });
  const statusLabel = params.status === "approved" ? "Approved" : "Rejected";
  const actor = params.decidedByName?.trim() || "a lead";
  const signedSuffix = params.approvalKind === "signature" && params.status === "approved" ? " (signed)" : "";
  const text = `${push?.title || "Reimbursement review"}\n${statusLabel} by ${actor}${signedSuffix}`;

  let updated = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const message of messages) {
    try {
      await updateMessage(message.channel_id, message.message_ts, text, blocks);
      updated += 1;
    } catch (error) {
      failed += 1;
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (failed === 0) {
    await updateReimbursementPushStatus({
      reimbursementId: params.reimbursementId,
      status: params.status,
    });
  }

  return {
    reimbursementId: params.reimbursementId,
    status: params.status,
    updated,
    failed,
    errors,
  };
}

export async function pollPendingReimbursementStatuses() {
  const createdAfter = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const ids = await getPendingReimbursementPushIds({ createdAfter, limit: 200 });
  if (ids.length === 0) {
    return { checked: 0, settled: 0, synced: [] as Awaited<ReturnType<typeof syncReimbursementMessages>>[] };
  }

  const statuses = await fetchReimbursementStatuses(ids);
  const synced: Awaited<ReturnType<typeof syncReimbursementMessages>>[] = [];

  for (const status of statuses) {
    if (status.status === "pending") {
      continue;
    }

    synced.push(
      await syncReimbursementMessages({
        reimbursementId: status.id,
        status: status.status,
        decidedByName: status.decided_by_name,
        approvalKind: status.approval_kind,
      }),
    );
  }

  return {
    checked: ids.length,
    settled: synced.length,
    synced,
  };
}
