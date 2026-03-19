import { NextResponse } from "next/server";
import { buildGoogleConsentUrl, parseGmailOAuthState } from "@/lib/google-oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");

  if (!state) {
    return NextResponse.json({ error: "missing_state" }, { status: 400 });
  }

  parseGmailOAuthState(state);
  return NextResponse.redirect(buildGoogleConsentUrl(state));
}
