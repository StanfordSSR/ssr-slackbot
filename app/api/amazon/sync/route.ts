import { NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { syncActiveAmazonAccountForDays } from "@/lib/amazon-orders";

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

  const result = await syncActiveAmazonAccountForDays(3);
  return NextResponse.json({ ok: true, result });
}
