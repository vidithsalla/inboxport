import { apiError, jsonNoStore, requestId } from "../../../../../lib/relay/api.ts";
import {
  GMAIL_COMPOSE_SCOPE,
  GMAIL_READONLY_SCOPE,
  getGmailReadiness,
  getRuntimeConfig,
  requireGmailConfig,
} from "../../../../../lib/relay/config.ts";
import { LocalEnvelopeVault } from "../../../../../lib/relay/crypto.ts";
import { createGoogleAuthorizationRequest } from "../../../../../lib/relay/google-oauth.ts";
import {
  createOAuthCookieHeader,
  safeReturnTo,
  sealGoogleOAuthCookie,
} from "../../../../../lib/relay/oauth-cookie.ts";
import { resolveRequestUser } from "../../../../../lib/relay/request-user.ts";

export async function GET(request: Request) {
  const id = requestId();
  const baseConfig = getRuntimeConfig();
  const user = await resolveRequestUser(request, baseConfig);
  if (!user) return jsonNoStore({ error: "AUTHENTICATION_REQUIRED", request_id: id }, { status: 401 });

  try {
    const config = requireGmailConfig(baseConfig);
    const readiness = getGmailReadiness(config);
    const upgrade = new URL(request.url).searchParams.get("upgrade");
    if (upgrade && upgrade !== "compose") {
      return jsonNoStore({ error: "UNKNOWN_SCOPE_UPGRADE", request_id: id }, { status: 400 });
    }
    const scopes = upgrade === "compose" ? [GMAIL_READONLY_SCOPE, GMAIL_COMPOSE_SCOPE] : [GMAIL_READONLY_SCOPE];
    const authorization = await createGoogleAuthorizationRequest(
      config,
      readiness.redirectUri,
      scopes,
    );
    const cookieVault = await LocalEnvelopeVault.fromEncodedKey(config.cookieKey);
    const returnTo = safeReturnTo(new URL(request.url).searchParams.get("return_to"));
    const cookie = await sealGoogleOAuthCookie(cookieVault, {
      state: authorization.state,
      codeVerifier: authorization.codeVerifier,
      userId: user.id,
      returnTo,
      createdAt: new Date().toISOString(),
      scopeUpgrade: upgrade === "compose" ? "compose" : null,
    });
    const headers = new Headers({
      location: authorization.url,
      "cache-control": "no-store",
      "set-cookie": createOAuthCookieHeader(cookie, config.appUrl.startsWith("https://")),
      "x-relay-request-id": id,
    });
    headers.set("referrer-policy", "no-referrer");
    return new Response(null, { status: 302, headers });
  } catch (error) {
    return apiError(error, id);
  }
}
