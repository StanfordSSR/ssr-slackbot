import { NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { syncActiveAmazonAccount } from "@/lib/amazon-orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const secret = getEnv("AMAZON_CRON_SECRET") || getEnv("GMAIL_CRON_SECRET");
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const now = new Date();
  const pacificHour = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "2-digit",
    hour12: false,
  }).format(now);

  if (pacificHour !== "00" && pacificHour !== "24") {
    return NextResponse.json({ ok: true, skipped: true, reason: "outside_midnight_pacific" });
  }

  const result = await syncActiveAmazonAccount();
  return NextResponse.json({ ok: true, result });
}
