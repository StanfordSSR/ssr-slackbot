import { NextResponse } from "next/server";
import { verifySlackSignature } from "@/lib/slack-signature";
import { getEnv } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rawBody = await request.text();
  const signingSecret = getEnv("SLACK_SIGNING_SECRET")!;
  const isValid = await verifySlackSignature(request, rawBody, signingSecret);

  if (!isValid) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  return NextResponse.json({
    response_type: "ephemeral",
    text: "This bot now auto-matches users by their Slack email. DM it a receipt image or PDF to log a purchase.",
  });
}
