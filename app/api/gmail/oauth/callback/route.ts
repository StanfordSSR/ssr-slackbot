import { after, NextResponse } from "next/server";
import { exchangeGoogleCodeForTokens, fetchGoogleUserEmail, parseGmailOAuthState } from "@/lib/google-oauth";
import { encryptSecret } from "@/lib/secrets";
import { postDirectMessageToUser } from "@/lib/slack";
import { getTeamById, getGmailAccountLinkById, upsertGmailAccountLink } from "@/lib/supabase";
import { syncGmailLink } from "@/lib/gmail-receipts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return renderHtml(`Gmail linking failed: ${error}`);
  }

  if (!code || !state) {
    return NextResponse.json({ error: "missing_code_or_state" }, { status: 400 });
  }

  const parsed = parseGmailOAuthState(state);
  const tokens = await exchangeGoogleCodeForTokens(code);
  const googleIdentity = await fetchGoogleUserEmail(tokens.access_token);
  if (googleIdentity.email !== parsed.gmailEmail) {
    return renderHtml(`That Google account is ${googleIdentity.email}, but you asked to link ${parsed.gmailEmail}. Please retry with the matching Gmail account.`);
  }
  if (!tokens.refresh_token) {
    return renderHtml("Google did not return a refresh token. Remove the existing app access in Google and try linking again.");
  }

  const link = await upsertGmailAccountLink({
    teamId: parsed.teamId,
    linkedByProfileId: parsed.profileId,
    gmailEmail: googleIdentity.email,
    googleSubjectId: googleIdentity.googleSubjectId,
    refreshTokenEncrypted: encryptSecret(tokens.refresh_token),
    accessToken: tokens.access_token,
    accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
  });

  const team = await getTeamById(parsed.teamId);

  after(async () => {
    try {
      await postDirectMessageToUser(
        parsed.slackUserId,
        `Link successful. ${googleIdentity.email} is now connected to ${team?.name || "your team"}.`,
      );
      await postDirectMessageToUser(
        parsed.slackUserId,
        "Scanning for unread emails now. I’ll message you again with what I find.",
      );

      const freshLink = await getGmailAccountLinkById(link.id);
      if (freshLink) {
        const result = await syncGmailLink(freshLink);
        const windowLabel = result.initialBackfill ? "10 days" : "3 days";
        const summary =
          result.processed > 0
            ? `Scan complete. I checked ${result.unreadCount} unread email(s) from the last ${windowLabel} and drafted ${result.processed} receipt review message(s) in Slack.`
            : `Scan complete. I checked ${result.unreadCount} unread email(s) from the last ${windowLabel}, but none turned into receipt drafts.`;

        await postDirectMessageToUser(parsed.slackUserId, summary);
      } else {
        await postDirectMessageToUser(parsed.slackUserId, "The Gmail link saved, but I couldn't reload it for the first scan.");
      }
    } catch (error) {
      console.error("Failed to run initial Gmail sync after linking", error);
      await postDirectMessageToUser(
        parsed.slackUserId,
        "The Gmail link worked, but the first inbox scan hit a snag. Try again shortly or ask me to add a manual re-scan command.",
      );
    }
  });

  return renderHtml(`Gmail linked for ${team?.name || "your team"}. You can close this tab.`);
}

function renderHtml(message: string) {
  return new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8"><title>SSR Gmail Link</title></head><body style="font-family: sans-serif; padding: 32px;"><p>${escapeHtml(
      message,
    )}</p></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

function escapeHtml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
