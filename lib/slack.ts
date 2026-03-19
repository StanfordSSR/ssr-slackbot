import { getEnv } from "@/lib/env";
import { SlackUserIdentity } from "@/types/receipt";

const slackApiBase = "https://slack.com/api";

async function slackFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getEnv("SLACK_BOT_TOKEN");
  const response = await fetch(`${slackApiBase}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
      ...(init?.headers || {}),
    },
    cache: "no-store",
  });

  const json = (await response.json()) as T & { ok?: boolean; error?: string };

  if ((json as { ok?: boolean }).ok === false) {
    throw new Error(`Slack API error on ${path}: ${(json as { error?: string }).error ?? "unknown_error"}`);
  }

  return json;
}

async function slackFormFetch<T>(path: string, body: URLSearchParams) {
  const token = getEnv("SLACK_BOT_TOKEN");
  const response = await fetch(`${slackApiBase}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
    cache: "no-store",
  });

  const json = (await response.json()) as T & { ok?: boolean; error?: string };
  if ((json as { ok?: boolean }).ok === false) {
    throw new Error(`Slack API error on ${path}: ${(json as { error?: string }).error ?? "unknown_error"}`);
  }

  return json;
}

export async function postMessage(channel: string, text: string, blocks?: unknown[], threadTs?: string) {
  return slackFetch<PostMessageResponse>("/chat.postMessage", {
    method: "POST",
    body: JSON.stringify({ channel, text, blocks, thread_ts: threadTs }),
  });
}

export async function updateMessage(channel: string, ts: string, text: string, blocks?: unknown[]) {
  return slackFetch<PostMessageResponse>("/chat.update", {
    method: "POST",
    body: JSON.stringify({ channel, ts, text, blocks }),
  });
}

export async function postDm(channel: string, text: string, blocks?: unknown[]) {
  return postMessage(channel, text, blocks);
}

export async function fetchFileInfo(fileId: string) {
  return slackFetch<{ ok: true; file: Record<string, unknown> }>(`/files.info?file=${encodeURIComponent(fileId)}`);
}

export async function fetchConversationHistory(channel: string, limit = 15) {
  return slackFetch<{
    ok: true;
    messages: Array<{
      user?: string;
      text?: string;
      ts?: string;
      subtype?: string;
      bot_id?: string;
    }>;
  }>(`/conversations.history?channel=${encodeURIComponent(channel)}&limit=${encodeURIComponent(String(limit))}`);
}

export async function openDirectMessage(userId: string) {
  const result = await slackFormFetch<{ ok: true; channel: { id: string } }>(
    "/conversations.open",
    new URLSearchParams({ users: userId }),
  );
  return result.channel.id;
}

export async function postDirectMessageToUser(userId: string, text: string, blocks?: unknown[]) {
  const channel = await openDirectMessage(userId);
  return postMessage(channel, text, blocks);
}

export async function lookupSlackUserIdByEmail(email: string) {
  const result = await slackFetch<{
    ok: true;
    user: {
      id: string;
    };
  }>(`/users.lookupByEmail?email=${encodeURIComponent(email)}`);

  return result.user.id;
}

export async function downloadSlackFile(url: string) {
  const token = getEnv("SLACK_BOT_TOKEN");
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Could not download Slack file: ${response.status}`);
  }

  return {
    arrayBuffer: await response.arrayBuffer(),
    contentType: response.headers.get("content-type") || "application/octet-stream",
  };
}

export async function getSlackUserIdentity(userId: string): Promise<SlackUserIdentity> {
  const result = await slackFetch<{
    ok: true;
    user: {
      id: string;
      profile?: { email?: string; display_name?: string; real_name?: string };
      real_name?: string;
      name?: string;
    };
  }>(`/users.info?user=${encodeURIComponent(userId)}`);

  const email = result.user.profile?.email?.trim().toLowerCase();
  if (!email) {
    throw new Error("Slack did not return an email for this user. Check users:read and users:read.email scopes.");
  }

  return {
    slackUserId: result.user.id,
    email,
    displayName: result.user.profile?.display_name || result.user.name || null,
    realName: result.user.profile?.real_name || result.user.real_name || null,
  };
}
