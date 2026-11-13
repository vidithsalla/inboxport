import { apiError, jsonNoStore, requestId } from "../../../../../lib/relay/api.ts";
import {
  MICROSOFT_MAIL_READ_SCOPE,
  MICROSOFT_MAIL_READWRITE_SCOPE,
  MICROSOFT_MAIL_SEND_SCOPE,
  MICROSOFT_OFFLINE_ACCESS_SCOPE,
  MICROSOFT_OPENID_SCOPE,
  MICROSOFT_USER_READ_SCOPE,
  getRuntimeConfig,
  getMicrosoftReadiness,
  requireMicrosoftConfig,
} from "../../../../../lib/relay/config.ts";
import { LocalEnvelopeVault } from "../../../../../lib/relay/crypto.ts";
import { createMicrosoftAuthorizationRequest } from "../../../../../lib/relay/microsoft-oauth.ts";
import {
  createMicrosoftOAuthCookieHeader,
  sealMicrosoftOAuthCookie,
} from "../../../../../lib/relay/microsoft-oauth-cookie.ts";
import { safeReturnTo } from "../../../../../lib/relay/oauth-cookie.ts";
import { resolveRequestUser } from "../../../../../lib/relay/request-user.ts";

export async function GET(request: Request) {
  const id = requestId();
  const baseConfig = getRuntimeConfig();
  const user = await resolveRequestUser(request, baseConfig);
  if (!user) return jsonNoStore({ error: "AUTHENTICATION_REQUIRED", request_id: id }, { status: 401 });

  try {
    const config = requireMicrosoftConfig(baseConfig);
    const readiness = getMicrosoftReadiness(config);
    const upgrade = new URL(request.url).searchParams.get("upgrade");
    if (upgrade && upgrade !== "compose") {
      return jsonNoStore({ error: "UNKNOWN_SCOPE_UPGRADE", request_id: id }, { status: 400 });
    }
    const baseScopes = [
      MICROSOFT_OPENID_SCOPE,
      MICROSOFT_OFFLINE_ACCESS_SCOPE,
      MICROSOFT_MAIL_READ_SCOPE,
      MICROSOFT_USER_READ_SCOPE,
    ];
    const scopes =
      upgrade === "compose"
        ? [...baseScopes, MICROSOFT_MAIL_READWRITE_SCOPE, MICROSOFT_MAIL_SEND_SCOPE]
        : baseScopes;
    const authorization = await createMicrosoftAuthorizationRequest(config, readiness.redirectUri, scopes);
    const cookieVault = await LocalEnvelopeVault.fromEncodedKey(config.cookieKey);
    const returnTo = safeReturnTo(new URL(request.url).searchParams.get("return_to"));
    const cookie = await sealMicrosoftOAuthCookie(cookieVault, {
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
      "set-cookie": createMicrosoftOAuthCookieHeader(cookie, config.appUrl.startsWith("https://")),
      "x-relay-request-id": id,
    });
    headers.set("referrer-policy", "no-referrer");
    return new Response(null, { status: 302, headers });
  } catch (error) {
    return apiError(error, id);
  }
}
