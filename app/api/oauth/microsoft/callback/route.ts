import { apiError, jsonNoStore, requestId } from "../../../../../lib/relay/api.ts";
import { getRuntimeConfig, getMicrosoftReadiness, requireMicrosoftConfig } from "../../../../../lib/relay/config.ts";
import { exchangeMicrosoftAuthorizationCode } from "../../../../../lib/relay/microsoft-oauth.ts";
import {
  MICROSOFT_OAUTH_COOKIE,
  MICROSOFT_OAUTH_TTL_SECONDS,
  clearMicrosoftOAuthCookieHeader,
  openMicrosoftOAuthCookie,
} from "../../../../../lib/relay/microsoft-oauth-cookie.ts";
import { readCookie } from "../../../../../lib/relay/oauth-cookie.ts";
import { resolveRequestUser } from "../../../../../lib/relay/request-user.ts";
import { getOutlookRuntime } from "../../../../../lib/relay/outlook-runtime.ts";

const redirectWithResult = (
  config: { appUrl: string },
  returnTo: string,
  result: "connected" | "denied" | "failed",
  clearCookie: string,
  scopeUpgrade: "compose" | null = null,
): Response => {
  const destination = new URL(returnTo, config.appUrl);
  destination.searchParams.set("relay_microsoft", result);
  if (scopeUpgrade) destination.searchParams.set("relay_microsoft_scope", scopeUpgrade);
  return new Response(null, {
    status: 302,
    headers: {
      location: destination.toString(),
      "cache-control": "no-store",
      "set-cookie": clearCookie,
      "referrer-policy": "no-referrer",
    },
  });
};

export async function GET(request: Request) {
  const id = requestId();
  const baseConfig = getRuntimeConfig();
  const secure = baseConfig.appUrl.startsWith("https://");
  const clearCookie = clearMicrosoftOAuthCookieHeader(secure);
  const user = await resolveRequestUser(request, baseConfig);
  if (!user) return jsonNoStore({ error: "AUTHENTICATION_REQUIRED", request_id: id }, { status: 401 });

  try {
    const config = requireMicrosoftConfig(baseConfig);
    const { cookieVault, service } = await getOutlookRuntime();
    const value = readCookie(request, MICROSOFT_OAUTH_COOKIE);
    if (!value) return jsonNoStore({ error: "MICROSOFT_OAUTH_COOKIE_MISSING", request_id: id }, { status: 400 });
    const transaction = await openMicrosoftOAuthCookie(cookieVault, value);
    const url = new URL(request.url);
    const state = url.searchParams.get("state");
    const age = Date.now() - new Date(transaction.createdAt).getTime();
    // Bind every callback -- a success or a provider-reported error -- to this
    // user's own, unexpired transaction before acting on it. The OAuth error
    // redirect also carries `state`, so a missing or mismatched state on the
    // denial branch is rejected rather than honored as a "denied" result.
    if (
      !state ||
      state !== transaction.state ||
      transaction.userId !== user.id ||
      !Number.isFinite(age) ||
      age < 0 ||
      age > MICROSOFT_OAUTH_TTL_SECONDS * 1000
    ) {
      return jsonNoStore({ error: "MICROSOFT_OAUTH_TRANSACTION_REJECTED", request_id: id }, { status: 400 });
    }
    if (url.searchParams.get("error")) {
      return redirectWithResult(config, transaction.returnTo, "denied", clearCookie);
    }
    const code = url.searchParams.get("code");
    if (!code) {
      return jsonNoStore({ error: "MICROSOFT_OAUTH_TRANSACTION_REJECTED", request_id: id }, { status: 400 });
    }
    const tokens = await exchangeMicrosoftAuthorizationCode(
      config,
      getMicrosoftReadiness(config).redirectUri,
      code,
      transaction.codeVerifier,
    );
    await service.connect(user, tokens, id);
    return redirectWithResult(config, transaction.returnTo, "connected", clearCookie, transaction.scopeUpgrade);
  } catch (error) {
    const response = apiError(error, id);
    response.headers.append("set-cookie", clearCookie);
    return response;
  }
}
