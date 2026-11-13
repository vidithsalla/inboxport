import assert from "node:assert/strict";
import test from "node:test";
import { GMAIL_COMPOSE_SCOPE, GMAIL_READONLY_SCOPE, type RuntimeConfig } from "../../lib/relay/config.ts";
import {
  LocalEnvelopeVault,
  parseEnvelope,
  serializeEnvelope,
} from "../../lib/relay/crypto.ts";
import { createGoogleAuthorizationRequest } from "../../lib/relay/google-oauth.ts";
import {
  openGoogleOAuthCookie,
  safeReturnTo,
  sealGoogleOAuthCookie,
} from "../../lib/relay/oauth-cookie.ts";

const encodedKey = (fill: number) => Buffer.alloc(32, fill).toString("base64url");

test("credential envelope is bound to its account context", async () => {
  const vault = await LocalEnvelopeVault.fromEncodedKey(encodedKey(7));
  const envelope = await vault.seal("refresh-token", "user_1:account_1");
  assert.equal(await vault.open(envelope, "user_1:account_1"), "refresh-token");
  await assert.rejects(() => vault.open(envelope, "user_1:account_2"));
});

test("credential envelope rejects ciphertext tampering", async () => {
  const vault = await LocalEnvelopeVault.fromEncodedKey(encodedKey(8));
  const envelope = await vault.seal("refresh-token", "context");
  const first = envelope.ciphertext[0] === "A" ? "B" : "A";
  const tampered = parseEnvelope(
    serializeEnvelope({
      ...envelope,
      ciphertext: `${first}${envelope.ciphertext.slice(1)}`,
    }),
  );
  await assert.rejects(() => vault.open(tampered, "context"));
});

test("provider-subject fingerprints are keyed and context-bound", async () => {
  const firstVault = await LocalEnvelopeVault.fromEncodedKey(encodedKey(10));
  const secondVault = await LocalEnvelopeVault.fromEncodedKey(encodedKey(11));
  const value = "tester@example.com";
  const first = await firstVault.fingerprint(value, "gmail-subject");
  assert.equal(first, await firstVault.fingerprint(value, "gmail-subject"));
  assert.notEqual(first, await firstVault.fingerprint(value, "other-context"));
  assert.notEqual(first, await secondVault.fingerprint(value, "gmail-subject"));
  assert.doesNotMatch(first, /tester|example/i);
});

test("OAuth transaction cookie is encrypted and round-trips", async () => {
  const vault = await LocalEnvelopeVault.fromEncodedKey(encodedKey(9));
  const transaction = {
    state: "state-value",
    codeVerifier: "verifier-value",
    userId: "user_1",
    returnTo: "/?connected=1",
    createdAt: "2026-07-21T12:00:00.000Z",
    scopeUpgrade: null,
  };
  const cookie = await sealGoogleOAuthCookie(vault, transaction);
  assert.doesNotMatch(cookie, /verifier-value/);
  assert.deepEqual(await openGoogleOAuthCookie(vault, cookie), transaction);
});

test("OAuth authorization request uses least privilege, PKCE, and offline access", async () => {
  const config: RuntimeConfig & { googleClientId: string } = {
    appUrl: "http://localhost:3000",
    demoMode: true,
    autoMigrate: true,
    supportEmail: "support@example.com",
    allowedEmails: [],
    googleClientId: "client-id",
    googleClientSecret: null,
    microsoftClientId: null,
    microsoftClientSecret: null,
    cookieKey: null,
    vaultKek: null,
  };
  const request = await createGoogleAuthorizationRequest(
    config,
    "http://localhost:3000/api/oauth/google/callback",
  );
  const url = new URL(request.url);
  assert.equal(url.searchParams.get("scope"), GMAIL_READONLY_SCOPE);
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), request.state);
  assert.notEqual(url.searchParams.get("code_challenge"), request.codeVerifier);
});

test("a compose-scope upgrade requests exactly readonly plus compose, never send-only", async () => {
  const config: RuntimeConfig & { googleClientId: string } = {
    appUrl: "http://localhost:3000",
    demoMode: true,
    autoMigrate: true,
    supportEmail: "support@example.com",
    allowedEmails: [],
    googleClientId: "client-id",
    googleClientSecret: null,
    microsoftClientId: null,
    microsoftClientSecret: null,
    cookieKey: null,
    vaultKek: null,
  };
  const request = await createGoogleAuthorizationRequest(
    config,
    "http://localhost:3000/api/oauth/google/callback",
    [GMAIL_READONLY_SCOPE, GMAIL_COMPOSE_SCOPE],
  );
  const scope = new URL(request.url).searchParams.get("scope");
  assert.equal(scope, `${GMAIL_READONLY_SCOPE} ${GMAIL_COMPOSE_SCOPE}`);
});

test("the scope-upgrade marker round-trips through the OAuth transaction cookie", async () => {
  const vault = await LocalEnvelopeVault.fromEncodedKey(encodedKey(13));
  const transaction = {
    state: "state-value",
    codeVerifier: "verifier-value",
    userId: "user_1",
    returnTo: "/",
    createdAt: "2026-07-21T12:00:00.000Z",
    scopeUpgrade: "compose" as const,
  };
  const cookie = await sealGoogleOAuthCookie(vault, transaction);
  assert.deepEqual(await openGoogleOAuthCookie(vault, cookie), transaction);
});

test("OAuth return paths cannot escape the Relay origin", () => {
  assert.equal(safeReturnTo("/inboxes?connected=1"), "/inboxes?connected=1");
  assert.equal(safeReturnTo("https://attacker.example/steal"), "/");
  assert.equal(safeReturnTo("//attacker.example/steal"), "/");
});
