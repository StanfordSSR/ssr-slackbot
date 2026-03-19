import { NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { syncAllGmailLinks } from "@/lib/gmail-receipts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const secret = getEnv("GMAIL_CRON_SECRET");
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const results = await syncAllGmailLinks();
  return NextResponse.json({ ok: true, results });
}
