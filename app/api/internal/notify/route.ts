import { NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import {
  completeInternalNotificationRequest,
  createInternalNotificationRequest,
  getInternalNotificationRequestByKey,
  getProfileSlackMappingsByEmails,
  updateProfileSlackUserId,
} from "@/lib/supabase";
import { eventAnnouncementBlocks } from "@/lib/slack-blocks";
import { lookupSlackUserIdByEmail, postDirectMessageToUser } from "@/lib/slack";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type NotifyRequestBody = {
  idempotency_key: string;
  type: string;
  team_id?: string | null;
  team_name?: string | null;
  recipient_emails: string[];
  title: string;
  message: string;
  cta_label?: string | null;
  cta_url?: string | null;
  metadata?: Record<string, unknown>;
};

type NotifyResult = {
  email: string;
  ok: boolean;
  slack_user_id?: string;
  error?: string;
};

type EventAnnouncementMetadata = {
  announcementId: string | null;
  announcementType: "event";
  location: string | null;
  eventAt: string | null;
  recipientEmail: string | null;
  rsvpCallbackUrl: string | null;
};

function unauthorized() {
  return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
}

function badRequest(error: string) {
  return NextResponse.json({ ok: false, error }, { status: 400 });
}

function normalizeEmails(emails: string[]) {
  return [...new Set(emails.map((email) => email.trim().toLowerCase()).filter(Boolean))];
}

function buildBlocks(body: NotifyRequestBody) {
  const blocks: unknown[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${body.title}*`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: body.message,
      },
    },
  ];

  if (body.team_name || body.type) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: [body.team_name ? `Team: ${body.team_name}` : null, body.type ? `Type: ${body.type}` : null].filter(Boolean).join(" • "),
        },
      ],
    });
  }

  if (body.cta_label && body.cta_url) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: body.cta_label.slice(0, 75) },
          url: body.cta_url,
          action_id: "open_internal_notification_cta",
        },
      ],
    });
  }

  return blocks;
}

function buildText(body: NotifyRequestBody) {
  return [body.title, body.message, body.cta_url || null].filter(Boolean).join("\n");
}

function getEventAnnouncementMetadata(metadata: Record<string, unknown> | undefined) {
  if (!metadata || metadata.announcementType !== "event") {
    return null;
  }

  return {
    announcementId: typeof metadata.announcementId === "string" ? metadata.announcementId : null,
    announcementType: "event",
    location: typeof metadata.location === "string" ? metadata.location : null,
    eventAt: typeof metadata.eventAt === "string" ? metadata.eventAt : null,
    recipientEmail: typeof metadata.recipientEmail === "string" ? metadata.recipientEmail : null,
    rsvpCallbackUrl: typeof metadata.rsvpCallbackUrl === "string" ? metadata.rsvpCallbackUrl : null,
  } satisfies EventAnnouncementMetadata;
}

function splitEventDetails(message: string, location: string | null) {
  const trimmed = message.trim();
  if (!trimmed) return "";

  const lines = trimmed.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return "";
  if (location && lines[0].toLowerCase() === location.trim().toLowerCase()) {
    return lines.slice(1).join("\n");
  }
  return trimmed;
}

function describeError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  if (error && typeof error === "object") {
    const maybeError = error as { code?: string; message?: string; details?: string; hint?: string; error?: string };
    const parts = [maybeError.code, maybeError.message || maybeError.error, maybeError.details, maybeError.hint].filter(Boolean);
    if (parts.length > 0) {
      return parts.join(": ");
    }

    try {
      return JSON.stringify(error);
    } catch {
      return "unknown_error_object";
    }
  }

  return String(error);
}

async function resolveSlackUserId(
  email: string,
  mappedByEmail: Map<string, { slackUserId: string | null; profileId?: string | null }>,
) {
  const mapped = mappedByEmail.get(email);
  if (mapped?.slackUserId) {
    return mapped.slackUserId;
  }

  const slackUserId = await lookupSlackUserIdByEmail(email);
  if (mapped?.profileId) {
    await updateProfileSlackUserId({ profileId: mapped.profileId, slackUserId });
  }
  return slackUserId;
}

export async function POST(request: Request) {
  const sharedSecret = getEnv("INTERNAL_NOTIFY_SHARED_SECRET");
  const authHeader = request.headers.get("authorization");
  if (!sharedSecret || authHeader !== `Bearer ${sharedSecret}`) {
    return unauthorized();
  }

  let body: NotifyRequestBody;
  try {
    body = (await request.json()) as NotifyRequestBody;
  } catch {
    return badRequest("invalid_json");
  }

  const recipientEmails = normalizeEmails(Array.isArray(body.recipient_emails) ? body.recipient_emails : []);
  const eventMetadata = getEventAnnouncementMetadata(body.metadata);
  if (!body.idempotency_key?.trim()) return badRequest("idempotency_key is required");
  if (!body.type?.trim()) return badRequest("type is required");
  if (!body.title?.trim()) return badRequest("title is required");
  if (!body.message?.trim()) return badRequest("message is required");
  if (recipientEmails.length === 0) return badRequest("recipient_emails must include at least one email");
  if (!eventMetadata && ((body.cta_label && !body.cta_url) || (!body.cta_label && body.cta_url))) {
    return badRequest("cta_label and cta_url must be provided together");
  }

  const existing = await getInternalNotificationRequestByKey(body.idempotency_key);
  if (existing?.status === "completed" || existing?.status === "failed") {
    return NextResponse.json({
      ...(existing.response_payload ?? { ok: existing.status === "completed" }),
      idempotent_replay: true,
      notification_request_id: existing.id,
    });
  }

  if (existing?.status === "processing") {
    return NextResponse.json(
      {
        ok: false,
        error: "idempotency_key already processing",
        notification_request_id: existing.id,
      },
      { status: 409 },
    );
  }

  const created = await createInternalNotificationRequest({
    idempotencyKey: body.idempotency_key,
    type: body.type,
    teamId: body.team_id ?? null,
    teamName: body.team_name ?? null,
    requestPayload: {
      ...body,
      recipient_emails: recipientEmails,
    },
  });

  if (!created) {
    const replay = await getInternalNotificationRequestByKey(body.idempotency_key);
    if (replay?.status === "completed" || replay?.status === "failed") {
      return NextResponse.json({
        ...(replay.response_payload ?? { ok: replay.status === "completed" }),
        idempotent_replay: true,
        notification_request_id: replay.id,
      });
    }

    return NextResponse.json(
      {
        ok: false,
        error: "idempotency_key already processing",
        notification_request_id: replay?.id ?? null,
      },
      { status: 409 },
    );
  }

  const mappedUsers = await getProfileSlackMappingsByEmails(recipientEmails);
  const mappedByEmail = new Map(
    mappedUsers.map((entry) => [entry.email, { slackUserId: entry.slackUserId, profileId: entry.profileId }]),
  );
  const results: NotifyResult[] = [];
  let delivered = 0;
  let failed = 0;

  for (const email of recipientEmails) {
    try {
      const slackUserId = await resolveSlackUserId(email, mappedByEmail);
      const blocks =
        eventMetadata?.announcementId && eventMetadata.rsvpCallbackUrl
          ? eventAnnouncementBlocks({
              title: body.title,
              eventAt: eventMetadata.eventAt ?? null,
              location: eventMetadata.location ?? null,
              details: splitEventDetails(body.message, eventMetadata.location ?? null),
              recipientEmail: eventMetadata.recipientEmail || email,
              announcementId: eventMetadata.announcementId,
              callbackUrl: eventMetadata.rsvpCallbackUrl,
            })
          : buildBlocks({ ...body, recipient_emails: recipientEmails });
      const text = buildText({ ...body, recipient_emails: recipientEmails });

      await postDirectMessageToUser(slackUserId, text, blocks);
      results.push({ email, ok: true, slack_user_id: slackUserId });
      delivered += 1;
    } catch (error) {
      results.push({ email, ok: false, error: describeError(error) });
      failed += 1;
    }
  }

  const responsePayload = {
    ok: failed === 0,
    delivered,
    failed,
    results,
    idempotency_key: body.idempotency_key,
    type: body.type,
    team_id: body.team_id ?? null,
    team_name: body.team_name ?? null,
    notification_request_id: created.id,
  };

  await completeInternalNotificationRequest({
    idempotencyKey: body.idempotency_key,
    status: failed === 0 ? "completed" : "failed",
    deliveredCount: delivered,
    failedCount: failed,
    responsePayload,
  });

  return NextResponse.json(responsePayload);
}
