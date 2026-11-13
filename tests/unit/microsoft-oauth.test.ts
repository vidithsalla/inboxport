import assert from "node:assert/strict";
import test from "node:test";
import {
  createMicrosoftAuthorizationRequest,
  exchangeMicrosoftAuthorizationCode,
} from "../../lib/relay/microsoft-oauth.ts";
import type { RuntimeConfig } from "../../lib/relay/config.ts";

const exchangeConfig: RuntimeConfig & { microsoftClientId: string; microsoftClientSecret: string } = {
  appUrl: "https://relay-mail-console.vercel.app",
  demoMode: false,
  autoMigrate: false,
  supportEmail: "support@example.com",
  allowedEmails: [],
  googleClientId: null,
  googleClientSecret: null,
  microsoftClientId: "ms-client-id",
  microsoftClientSecret: "ms-client-secret",
  cookieKey: null,
  vaultKek: null,
};

const config: RuntimeConfig & { microsoftClientId: string } = {
  appUrl: "https://relay-mail-console.vercel.app",
  demoMode: false,
  autoMigrate: false,
  supportEmail: "support@example.com",
  allowedEmails: [],
  googleClientId: null,
  googleClientSecret: null,
  microsoftClientId: "ms-client-id",
  microsoftClientSecret: null,
  cookieKey: null,
  vaultKek: null,
};

test("Microsoft authorization request uses PKCE and the least-privilege read scopes", async () => {
  const request = await createMicrosoftAuthorizationRequest(
    config,
    "https://relay-mail-console.vercel.app/api/oauth/microsoft/callback",
  );
  const url = new URL(request.url);
  const scope = url.searchParams.get("scope") ?? "";

  // Mail.Read for the mailbox, User.Read so `/me` can resolve the account's own
  // email at connect, plus openid + offline_access for identity and refresh.
  assert.ok(scope.split(" ").includes("Mail.Read"));
  assert.ok(scope.split(" ").includes("User.Read"));
  assert.ok(scope.split(" ").includes("offline_access"));
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(url.searchParams.get("code_challenge"));
  assert.equal(url.searchParams.get("response_type"), "code");
});

test("Microsoft authorization request carries an explicit compose scope upgrade through", async () => {
  const request = await createMicrosoftAuthorizationRequest(
    config,
    "https://relay-mail-console.vercel.app/api/oauth/microsoft/callback",
    ["openid", "offline_access", "Mail.Read", "User.Read", "Mail.ReadWrite", "Mail.Send"],
  );
  const scope = new URL(request.url).searchParams.get("scope") ?? "";
  assert.ok(scope.split(" ").includes("Mail.ReadWrite"));
  assert.ok(scope.split(" ").includes("Mail.Send"));
});

test("the token exchange sends no scope parameter, unlike the authorize request", async () => {
  let sentBody: URLSearchParams | undefined;
  const fetcher: typeof fetch = async (_input, init) => {
    sentBody = new URLSearchParams(init?.body as string);
    return Response.json({ access_token: "a", expires_in: 3600 });
  };
  await exchangeMicrosoftAuthorizationCode(
    exchangeConfig,
    "https://relay-mail-console.vercel.app/api/oauth/microsoft/callback",
    "auth-code",
    "verifier",
    fetcher,
  );
  // The authorization_code grant is scoped to whatever was actually
  // consented at /authorize, tied to the code itself -- sending a scope
  // here previously always claimed the base four scopes regardless of what
  // was actually requested, which would have silently under-scoped a
  // compose-upgrade token.
  assert.equal(sentBody?.has("scope"), false);
});
