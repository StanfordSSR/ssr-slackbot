import { getEnv, getGoogleScopes } from "@/lib/env";
import { signPayload, verifySignedPayload } from "@/lib/secrets";

type BaseOAuthState = {
  slackUserId: string;
  profileId: string;
  gmailEmail: string;
  issuedAt: number;
};

type GmailOAuthState = BaseOAuthState & {
  kind: "gmail";
  teamId: string;
};

type AmazonOAuthState = BaseOAuthState & {
  kind: "amazon";
  channelId: string;
};

type GoogleOAuthState = GmailOAuthState | AmazonOAuthState;

type GoogleTokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  id_token?: string;
};

function createGoogleOAuthState(input: Omit<GoogleOAuthState, "issuedAt">) {
  const payload = JSON.stringify({ ...input, issuedAt: Date.now() });
  const signature = signPayload(payload);
  return Buffer.from(JSON.stringify({ payload, signature }), "utf8").toString("base64url");
}

export function createGmailOAuthState(input: Omit<GmailOAuthState, "issuedAt" | "kind">) {
  return createGoogleOAuthState({ ...input, kind: "gmail" });
}

export function createAmazonOAuthState(input: Omit<AmazonOAuthState, "issuedAt">) {
  return createGoogleOAuthState(input);
}

export function parseGoogleOAuthState(state: string): GoogleOAuthState {
  const decoded = JSON.parse(Buffer.from(state, "base64url").toString("utf8")) as { payload: string; signature: string };
  if (!verifySignedPayload(decoded.payload, decoded.signature)) {
    throw new Error("Invalid Google OAuth state signature.");
  }

  const payload = JSON.parse(decoded.payload) as BaseOAuthState & { teamId?: string; channelId?: string; kind?: string };
  if (Date.now() - payload.issuedAt > 1000 * 60 * 30) {
    throw new Error("Google OAuth state expired.");
  }
  if (payload.kind === "amazon" && payload.channelId) {
    return payload as GoogleOAuthState;
  }
  if ((payload.kind === "gmail" || !payload.kind) && payload.teamId) {
    return { ...payload, kind: "gmail" } as GoogleOAuthState;
  }
  throw new Error("Invalid Google OAuth state payload.");
}

export function parseGmailOAuthState(state: string): GmailOAuthState {
  const payload = parseGoogleOAuthState(state);
  if (payload.kind !== "gmail") {
    throw new Error("Google OAuth state was not for Gmail receipt linking.");
  }
  return payload;
}

export function buildGoogleConsentUrl(state: string) {
  const clientId = getEnv("GOOGLE_CLIENT_ID");
  const redirectUri = getEnv("GOOGLE_REDIRECT_URI");
  if (!clientId || !redirectUri) {
    throw new Error("Missing Google OAuth configuration.");
  }

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", getGoogleScopes());
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  return url.toString();
}

async function googleTokenRequest(body: URLSearchParams) {
  const clientId = getEnv("GOOGLE_CLIENT_ID");
  const clientSecret = getEnv("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    throw new Error("Missing Google OAuth configuration.");
  }

  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });

  if (!response.ok) {
    const details = await response.text();
    const snippet = details.slice(0, 300);
    throw new Error(`Google token exchange failed: ${response.status}${snippet ? `: ${snippet}` : ""}`);
  }

  return (await response.json()) as GoogleTokenResponse;
}

export async function exchangeGoogleCodeForTokens(code: string) {
  const redirectUri = getEnv("GOOGLE_REDIRECT_URI");
  if (!redirectUri) {
    throw new Error("Missing GOOGLE_REDIRECT_URI.");
  }

  return googleTokenRequest(
    new URLSearchParams({
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  );
}

export async function refreshGoogleAccessToken(refreshToken: string) {
  return googleTokenRequest(
    new URLSearchParams({
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  );
}

export async function fetchGoogleUserEmail(accessToken: string) {
  const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Google userinfo lookup failed: ${response.status}`);
  }

  const json = (await response.json()) as { email?: string; sub?: string };
  if (!json.email || !json.sub) {
    throw new Error("Google OAuth user info did not include email and subject.");
  }

  return { email: json.email.trim().toLowerCase(), googleSubjectId: json.sub };
}
