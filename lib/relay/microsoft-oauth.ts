import {
  MICROSOFT_MAIL_READ_SCOPE,
  MICROSOFT_OFFLINE_ACCESS_SCOPE,
  MICROSOFT_OPENID_SCOPE,
  MICROSOFT_USER_READ_SCOPE,
  type RuntimeConfig,
} from "./config.ts";
import { randomOpaque, sha256Base64Url } from "./crypto.ts";

/**
 * The `common` tenant accepts both personal Microsoft accounts and
 * work/school Microsoft 365 accounts, matching the Entra app registration's
 * "accounts in any organizational directory and personal Microsoft accounts"
 * option -- confirmed against current Microsoft identity platform docs.
 */
const MICROSOFT_AUTHORIZATION_ENDPOINT =
  "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const MICROSOFT_TOKEN_ENDPOINT = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

export type MicrosoftAuthorizationRequest = Readonly<{
  url: string;
  state: string;
  codeVerifier: string;
}>;

export type MicrosoftTokenSet = Readonly<{
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
  scopes: readonly string[];
  tokenType: string;
}>;

export class MicrosoftOAuthError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const DEFAULT_SCOPES = [
  MICROSOFT_OPENID_SCOPE,
  MICROSOFT_OFFLINE_ACCESS_SCOPE,
  MICROSOFT_MAIL_READ_SCOPE,
  MICROSOFT_USER_READ_SCOPE,
];

export async function createMicrosoftAuthorizationRequest(
  config: RuntimeConfig & { microsoftClientId: string },
  redirectUri: string,
  scopes: readonly string[] = DEFAULT_SCOPES,
): Promise<MicrosoftAuthorizationRequest> {
  const state = randomOpaque(32);
  const codeVerifier = randomOpaque(64);
  const codeChallenge = await sha256Base64Url(codeVerifier);
  const url = new URL(MICROSOFT_AUTHORIZATION_ENDPOINT);
  url.searchParams.set("client_id", config.microsoftClientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return { url: url.toString(), state, codeVerifier };
}

const parseTokenResponse = async (response: Response): Promise<MicrosoftTokenSet> => {
  if (!response.ok) {
    throw new MicrosoftOAuthError("MICROSOFT_TOKEN_EXCHANGE_FAILED", response.status);
  }
  const payload = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
  };
  if (!payload.access_token || !payload.expires_in) {
    throw new MicrosoftOAuthError("MICROSOFT_TOKEN_RESPONSE_INVALID", 502);
  }
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? null,
    expiresIn: payload.expires_in,
    scopes: (payload.scope ?? "").split(/\s+/).filter(Boolean),
    tokenType: payload.token_type ?? "Bearer",
  };
};

export async function exchangeMicrosoftAuthorizationCode(
  config: RuntimeConfig & { microsoftClientId: string; microsoftClientSecret: string },
  redirectUri: string,
  code: string,
  codeVerifier: string,
  fetcher: typeof fetch = fetch,
): Promise<MicrosoftTokenSet> {
  const response = await fetcher(MICROSOFT_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.microsoftClientId,
      client_secret: config.microsoftClientSecret,
      code,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      // No `scope` here, matching exchangeGoogleAuthorizationCode: the
      // authorization_code grant is scoped to whatever was actually consented
      // at /authorize, tied to the code itself. A hardcoded scope here
      // previously always claimed the base four scopes regardless of what was
      // actually requested/consented -- for a compose-scope upgrade request,
      // that would silently under-scope the resulting token.
    }),
  });
  return parseTokenResponse(response);
}

export async function refreshMicrosoftAccessToken(
  config: RuntimeConfig & { microsoftClientId: string; microsoftClientSecret: string },
  refreshToken: string,
  fetcher: typeof fetch = fetch,
): Promise<MicrosoftTokenSet> {
  const response = await fetcher(MICROSOFT_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.microsoftClientId,
      client_secret: config.microsoftClientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  return parseTokenResponse(response);
}

/**
 * Unlike Google, Microsoft's identity platform has no simple REST endpoint
 * to revoke a single refresh token. Disconnecting an Outlook account
 * crypto-shreds the stored credential locally; it does not (and, per current
 * Microsoft documentation, cannot easily) revoke the grant on Microsoft's
 * side the way `revokeGoogleToken` does for Google. This is an intentional,
 * documented platform difference, not an oversight -- see
 * docs/data-storage-and-authentication.md.
 */
export const MICROSOFT_REVOCATION_NOT_SUPPORTED = true;
