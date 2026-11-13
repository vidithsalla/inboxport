import { GMAIL_READONLY_SCOPE, type RuntimeConfig } from "./config.ts";
import { randomOpaque, sha256Base64Url } from "./crypto.ts";

const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOCATION_ENDPOINT = "https://oauth2.googleapis.com/revoke";

export type GoogleAuthorizationRequest = Readonly<{
  url: string;
  state: string;
  codeVerifier: string;
}>;

export type GoogleTokenSet = Readonly<{
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
  scopes: readonly string[];
  tokenType: string;
}>;

export class GoogleOAuthError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(
    code: string,
    status: number,
  ) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export async function createGoogleAuthorizationRequest(
  config: RuntimeConfig & { googleClientId: string },
  redirectUri: string,
  scopes: readonly string[] = [GMAIL_READONLY_SCOPE],
): Promise<GoogleAuthorizationRequest> {
  const state = randomOpaque(32);
  const codeVerifier = randomOpaque(64);
  const codeChallenge = await sha256Base64Url(codeVerifier);
  const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
  url.searchParams.set("client_id", config.googleClientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return { url: url.toString(), state, codeVerifier };
}

const parseTokenResponse = async (response: Response): Promise<GoogleTokenSet> => {
  if (!response.ok) {
    throw new GoogleOAuthError("GOOGLE_TOKEN_EXCHANGE_FAILED", response.status);
  }
  const payload = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
  };
  if (!payload.access_token || !payload.expires_in) {
    throw new GoogleOAuthError("GOOGLE_TOKEN_RESPONSE_INVALID", 502);
  }
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? null,
    expiresIn: payload.expires_in,
    scopes: (payload.scope ?? "").split(/\s+/).filter(Boolean),
    tokenType: payload.token_type ?? "Bearer",
  };
};

export async function exchangeGoogleAuthorizationCode(
  config: RuntimeConfig & { googleClientId: string; googleClientSecret: string },
  redirectUri: string,
  code: string,
  codeVerifier: string,
  fetcher: typeof fetch = fetch,
): Promise<GoogleTokenSet> {
  const response = await fetcher(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      code,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
  return parseTokenResponse(response);
}

export async function refreshGoogleAccessToken(
  config: RuntimeConfig & { googleClientId: string; googleClientSecret: string },
  refreshToken: string,
  fetcher: typeof fetch = fetch,
): Promise<GoogleTokenSet> {
  const response = await fetcher(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  return parseTokenResponse(response);
}

export async function revokeGoogleToken(
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const response = await fetcher(GOOGLE_REVOCATION_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  });
  return response.ok;
}
