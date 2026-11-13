import assert from "node:assert/strict";
import test from "node:test";
import { MICROSOFT_MAIL_READ_SCOPE, type RuntimeConfig } from "../../lib/relay/config.ts";
import { LocalEnvelopeVault, parseEnvelope } from "../../lib/relay/crypto.ts";
import { OutlookReadOnlyService } from "../../lib/relay/outlook-service.ts";
import type {
  OutlookMessage,
  OutlookProfile,
  OutlookProvider,
  OutlookSearchResult,
  OutlookThread,
} from "../../lib/relay/providers/outlook.ts";
import { MemoryRepository } from "./support/memory-repository.ts";

const profile: OutlookProfile = { emailAddress: "tester@outlook.com" };

const searchResult: OutlookSearchResult = {
  id: "m1",
  threadId: "t1",
  internalDate: "2026-07-22T12:00:00Z",
  from: "sender@example.net",
  subject: "Private subject",
  date: "2026-07-22T12:00:00Z",
  snippet: "Private snippet",
};

class FakeOutlookAdapter implements OutlookProvider {
  searchCalls = 0;
  async getProfile() {
    return profile;
  }
  async search(): Promise<readonly OutlookSearchResult[]> {
    this.searchCalls += 1;
    return [searchResult];
  }
  async getMessage(): Promise<OutlookMessage> {
    return { ...searchResult, to: "tester@outlook.com", cc: null, bodyText: "Private body", bodyTruncated: false };
  }
  async getThread(): Promise<OutlookThread> {
    return { id: "t1", messages: [await this.getMessage()] };
  }
  // This file tests only the console's read-only OutlookReadOnlyService,
  // which has no compose capability; these should never be called here.
  async createDraft(): Promise<never> {
    throw new Error("not implemented in this fake");
  }
  async updateDraft(): Promise<never> {
    throw new Error("not implemented in this fake");
  }
  async getDraft(): Promise<never> {
    throw new Error("not implemented in this fake");
  }
  async sendDraft(): Promise<never> {
    throw new Error("not implemented in this fake");
  }
}

const config: RuntimeConfig & { microsoftClientId: string; microsoftClientSecret: string } = {
  appUrl: "http://localhost:3000",
  demoMode: true,
  autoMigrate: true,
  supportEmail: "support@example.com",
  allowedEmails: [],
  googleClientId: null,
  googleClientSecret: null,
  microsoftClientId: "ms-client-id",
  microsoftClientSecret: "ms-client-secret",
  cookieKey: null,
  vaultKek: null,
};

const tokenFetcher: typeof fetch = async (input) => {
  const url = String(input);
  if (url.includes("/token")) {
    return Response.json({ access_token: "short-access", expires_in: 3600, token_type: "Bearer" });
  }
  throw new Error("unexpected fetch");
};

const connectTokens = {
  accessToken: "initial-access",
  refreshToken: "private-refresh-token",
  expiresIn: 3600,
  scopes: ["openid", "offline_access", MICROSOFT_MAIL_READ_SCOPE],
  tokenType: "Bearer",
};

test("connect stores only an encrypted address and refresh credential", async () => {
  const repository = new MemoryRepository();
  const vault = await LocalEnvelopeVault.fromEncodedKey(Buffer.alloc(32, 41).toString("base64url"));
  const service = new OutlookReadOnlyService(repository, vault, config, new FakeOutlookAdapter(), tokenFetcher);
  const user = { id: "user_1", email: "owner@example.com" };
  const connected = await service.connect(user, connectTokens, "request_connect");

  assert.equal(connected.provider, "microsoft");
  const stored = repository.accounts.get(connected.id);
  assert.ok(stored);
  assert.equal(stored?.provider, "microsoft");
  assert.doesNotMatch(stored.encryptedAddress, /tester@outlook\.com/);
  assert.doesNotMatch(stored.credentialEnvelope ?? "", /private-refresh-token/);
  assert.equal((await service.listAccounts(user))[0].address, "tester@outlook.com");
});

test("connect requires Mail.Read to have actually been granted", async () => {
  const repository = new MemoryRepository();
  const vault = await LocalEnvelopeVault.fromEncodedKey(Buffer.alloc(32, 42).toString("base64url"));
  const service = new OutlookReadOnlyService(repository, vault, config, new FakeOutlookAdapter(), tokenFetcher);
  const user = { id: "user_1", email: "owner@example.com" };
  await assert.rejects(
    () =>
      service.connect(
        user,
        { ...connectTokens, scopes: ["openid", "offline_access"] },
        "request_connect",
      ),
    /MICROSOFT_REQUIRED_SCOPE_NOT_GRANTED/,
  );
});

test("search is authorized, refreshes just in time, and audits no content", async () => {
  const repository = new MemoryRepository();
  const vault = await LocalEnvelopeVault.fromEncodedKey(Buffer.alloc(32, 43).toString("base64url"));
  const service = new OutlookReadOnlyService(repository, vault, config, new FakeOutlookAdapter(), tokenFetcher);
  const user = { id: "user_1", email: "owner@example.com" };
  const account = await service.connect(user, connectTokens, "request_connect");

  const results = await service.search(user, account.id, "private search query", 20, "request_search");
  assert.equal(results[0].subject, "Private subject");
  const serializedAudit = JSON.stringify(repository.audit);
  assert.doesNotMatch(serializedAudit, /private search query/i);
  assert.doesNotMatch(serializedAudit, /private subject/i);
  assert.doesNotMatch(serializedAudit, /private snippet/i);
  assert.equal(repository.audit.at(-1)?.operation, "mail.search");
});

test("a successful Outlook request clears a stale provider error", async () => {
  const repository = new MemoryRepository();
  const vault = await LocalEnvelopeVault.fromEncodedKey(Buffer.alloc(32, 47).toString("base64url"));
  const service = new OutlookReadOnlyService(repository, vault, config, new FakeOutlookAdapter(), tokenFetcher);
  const user = { id: "user_1", email: "owner@example.com" };
  const account = await service.connect(user, connectTokens, "request_connect");
  await repository.setAccountHealth(user.id, account.id, "provider_error");

  await service.search(user, account.id, "anything", 20, "request_search");

  assert.equal((await repository.getAccount(user.id, account.id))?.health, "healthy");
});

test("a rotated Microsoft refresh token is re-encrypted and persisted", async () => {
  const repository = new MemoryRepository();
  const vault = await LocalEnvelopeVault.fromEncodedKey(Buffer.alloc(32, 45).toString("base64url"));
  const rotatingFetcher: typeof fetch = async (input) => {
    if (String(input).includes("/token")) {
      return Response.json({
        access_token: "short-access",
        refresh_token: "rotated-refresh-token",
        expires_in: 3600,
        token_type: "Bearer",
      });
    }
    throw new Error("unexpected fetch");
  };
  const service = new OutlookReadOnlyService(repository, vault, config, new FakeOutlookAdapter(), rotatingFetcher);
  const user = { id: "user_1", email: "owner@example.com" };
  const account = await service.connect(user, connectTokens, "request_connect");
  const before = repository.accounts.get(account.id)?.credentialEnvelope;

  await service.search(user, account.id, "anything", 20, "request_search");

  const after = repository.accounts.get(account.id)?.credentialEnvelope;
  assert.notEqual(after, before);
  const decrypted = await vault.open(
    parseEnvelope(after ?? ""),
    `relay-mail:credential:${user.id}:${account.id}:microsoft:v1`,
  );
  assert.equal(decrypted, "rotated-refresh-token");
});

test("paused account fails closed before Graph access", async () => {
  const repository = new MemoryRepository();
  const vault = await LocalEnvelopeVault.fromEncodedKey(Buffer.alloc(32, 44).toString("base64url"));
  const service = new OutlookReadOnlyService(repository, vault, config, new FakeOutlookAdapter(), tokenFetcher);
  const user = { id: "user_1", email: "owner@example.com" };
  const account = await service.connect(user, connectTokens, "request_connect");
  await service.setPaused(user, account.id, true, "request_pause");
  await assert.rejects(
    () => service.search(user, account.id, "anything", 20, "request_search"),
    /ACCOUNT_PAUSED/,
  );
  assert.equal(repository.audit.at(-1)?.decision, "blocked");
});

test("disconnect completes locally with no revocation_pending state (Microsoft has no revoke endpoint)", async () => {
  const repository = new MemoryRepository();
  const vault = await LocalEnvelopeVault.fromEncodedKey(Buffer.alloc(32, 45).toString("base64url"));
  const service = new OutlookReadOnlyService(repository, vault, config, new FakeOutlookAdapter(), tokenFetcher);
  const user = { id: "user_1", email: "owner@example.com" };
  const account = await service.connect(user, connectTokens, "request_connect");
  const state = await service.disconnect(user, account.id, "request_disconnect");
  assert.equal(state, "disconnected");
  const stored = repository.accounts.get(account.id);
  assert.equal(stored?.state, "disconnected");
  assert.equal(stored?.credentialEnvelope, null);
});

test("rate limiting denies before token refresh and provider access", async () => {
  class RateLimitedRepository extends MemoryRepository {
    override async consumeRateLimit() {
      return { allowed: false, remaining: 0, resetAt: "2026-07-22T12:01:00.000Z" };
    }
  }
  const repository = new RateLimitedRepository();
  const vault = await LocalEnvelopeVault.fromEncodedKey(Buffer.alloc(32, 46).toString("base64url"));
  const adapter = new FakeOutlookAdapter();
  let tokenRefreshes = 0;
  const countingFetcher: typeof fetch = async () => {
    tokenRefreshes += 1;
    return Response.json({ access_token: "short-access", expires_in: 3600 });
  };
  const service = new OutlookReadOnlyService(repository, vault, config, adapter, countingFetcher);
  const user = { id: "user_1", email: "owner@example.com" };
  const account = await service.connect(user, connectTokens, "request_connect");
  await assert.rejects(
    () => service.search(user, account.id, "anything", 20, "request_search"),
    /RATE_LIMITED/,
  );
  assert.equal(tokenRefreshes, 0);
  assert.equal(adapter.searchCalls, 0);
  assert.equal(repository.audit.at(-1)?.providerResultClass, "rate_limited");
});
