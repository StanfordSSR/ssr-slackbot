import { NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { syncProfileSlackUsers } from "@/lib/slack-users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const secret = getEnv("CRON_SECRET");
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const result = await syncProfileSlackUsers();
  return NextResponse.json({ ok: true, result });
}
