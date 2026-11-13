import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeConfig } from "../../lib/relay/config.ts";
import { LocalEnvelopeVault } from "../../lib/relay/crypto.ts";
import {
  handleGmailPushNotification,
  reconcileAccountHistory,
  renewAllWatches,
  renewWatchForAccount,
  verifyPubSubPushToken,
  type GmailSyncDependencies,
} from "../../lib/relay/gmail-sync-service.ts";
import { GMAIL_SUBJECT_HASH_CONTEXT } from "../../lib/relay/providers/gmail.ts";
import {
  GmailApiError,
  type GmailDraftContent,
  type GmailDraftResult,
  type GmailHistoryPage,
  type GmailMessage,
  type GmailProfile,
  type GmailProvider,
  type GmailSearchResult,
  type GmailSendResult,
  type GmailThread,
  type GmailWatchResult,
} from "../../lib/relay/providers/gmail.ts";
import type { StoredMailAccount } from "../../lib/relay/repository.ts";
import { MemoryRepository } from "./support/memory-repository.ts";

type HistoryBehavior = "success" | "not_found" | "other_error";
type WatchBehavior = "success" | "failure";

class FakeGmailAdapter implements GmailProvider {
  historyBehavior: HistoryBehavior = "success";
  watchBehavior: WatchBehavior = "success";
  historyListCalls: string[] = [];
  watchCalls = 0;

  async getProfile(): Promise<GmailProfile> {
    return { emailAddress: "tester@example.com", messagesTotal: 1, threadsTotal: 1, historyId: "1" };
  }
  async search(): Promise<readonly GmailSearchResult[]> {
    return [];
  }
  async getMessage(): Promise<GmailMessage> {
    throw new Error("not used");
  }
  async getThread(): Promise<GmailThread> {
    throw new Error("not used");
  }
  async createDraft(): Promise<GmailDraftResult> {
    throw new Error("not used");
  }
  async updateDraft(): Promise<GmailDraftResult> {
    throw new Error("not used");
  }
  async getDraft(): Promise<GmailDraftContent> {
    throw new Error("not used");
  }
  async sendDraft(): Promise<GmailSendResult> {
    throw new Error("not used");
  }
  async watch(): Promise<GmailWatchResult> {
    this.watchCalls += 1;
    if (this.watchBehavior === "failure") throw new GmailApiError("UPSTREAM_FAILED", 500);
    return { historyId: "500", expiration: String(Date.now() + 7 * 24 * 60 * 60 * 1000) };
  }
  async stopWatch(): Promise<void> {}
  async historyList(accessToken: string, startHistoryId: string): Promise<GmailHistoryPage> {
    this.historyListCalls.push(startHistoryId);
    if (this.historyBehavior === "not_found") throw new GmailApiError("NOT_FOUND", 404);
    if (this.historyBehavior === "other_error") throw new GmailApiError("UPSTREAM_FAILED", 500);
    return { historyId: "200", recordCount: 3, nextPageToken: null };
  }
}

const config: RuntimeConfig & { googleClientId: string; googleClientSecret: string } = {
  appUrl: "http://localhost:3000",
  demoMode: true,
  autoMigrate: true,
  supportEmail: "support@example.com",
  allowedEmails: [],
  googleClientId: "client-id",
  googleClientSecret: "client-secret",
  microsoftClientId: null,
  microsoftClientSecret: null,
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

async function setup(): Promise<{ deps: GmailSyncDependencies; repository: MemoryRepository; adapter: FakeGmailAdapter; account: StoredMailAccount }> {
  const repository = new MemoryRepository();
  const vault = await LocalEnvelopeVault.fromEncodedKey(Buffer.alloc(32, 31).toString("base64url"));
  const adapter = new FakeGmailAdapter();
  const deps: GmailSyncDependencies = { repository, vault, config, adapter, fetcher: tokenFetcher };

  const credentialEnvelope = await vault.seal("refresh-token", "relay-mail:credential:user_1:account_1:gmail:v1");
  const encryptedAddress = await vault.seal("tester@example.com", "relay-mail:address:user_1:account_1:gmail:v1");
  const providerSubjectHash = await vault.fingerprint("tester@example.com", GMAIL_SUBJECT_HASH_CONTEXT);
  const account: StoredMailAccount = {
    id: "account_1",
    userId: "user_1",
    provider: "gmail",
    providerSubjectHash,
    encryptedAddress: JSON.stringify(encryptedAddress),
    credentialEnvelope: JSON.stringify(credentialEnvelope),
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    paused: false,
    state: "connected",
    health: "healthy",
    historyId: "100",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    disconnectedAt: null,
  };
  await repository.upsertAccount(account);
  return { deps, repository, adapter, account };
}

test("verifyPubSubPushToken accepts a token from the exact configured service account", async () => {
  const ok = await verifyPubSubPushToken(
    "fake-token",
    "https://relay.example/api/webhooks/gmail",
    "push@my-project.iam.gserviceaccount.com",
    async () => ({
      email: "push@my-project.iam.gserviceaccount.com",
      email_verified: true,
      iss: "https://accounts.google.com",
    }),
  );
  assert.equal(ok, true);
});

test("verifyPubSubPushToken rejects a token from a different service account", async () => {
  const ok = await verifyPubSubPushToken(
    "fake-token",
    "https://relay.example/api/webhooks/gmail",
    "push@my-project.iam.gserviceaccount.com",
    async () => ({
      email: "attacker@evil.example",
      email_verified: true,
      iss: "https://accounts.google.com",
    }),
  );
  assert.equal(ok, false);
});

test("verifyPubSubPushToken rejects an unverified email claim", async () => {
  const ok = await verifyPubSubPushToken(
    "fake-token",
    "aud",
    "push@my-project.iam.gserviceaccount.com",
    async () => ({
      email: "push@my-project.iam.gserviceaccount.com",
      email_verified: false,
      iss: "https://accounts.google.com",
    }),
  );
  assert.equal(ok, false);
});

test("verifyPubSubPushToken rejects a wrong issuer", async () => {
  const ok = await verifyPubSubPushToken("fake-token", "aud", "push@example.com", async () => ({
    email: "push@example.com",
    email_verified: true,
    iss: "https://not-google.example",
  }));
  assert.equal(ok, false);
});

test("verifyPubSubPushToken rejects (never throws) when the verifier itself fails", async () => {
  const ok = await verifyPubSubPushToken("bad-token", "aud", "push@example.com", async () => {
    throw new Error("invalid signature");
  });
  assert.equal(ok, false);
});

test("reconcileAccountHistory advances the cursor and audits no content", async () => {
  const { deps, repository, account } = await setup();
  await reconcileAccountHistory(deps, account, "150", "req_1");

  const updated = await repository.getAccount("user_1", account.id);
  assert.equal(updated?.historyId, "200");
  const syncState = await repository.getSyncState(account.id);
  assert.equal(syncState?.health, "active");
  assert.ok(syncState?.lastReconciledAt);

  const serialized = JSON.stringify(repository.audit);
  assert.doesNotMatch(serialized, /tester@example\.com/);
  assert.equal(repository.audit.at(-1)?.operation, "account.history_synced");
  assert.equal(repository.audit.at(-1)?.resultCount, 3);
});

test("reconcileAccountHistory falls back to a full resync on a 404 startHistoryId", async () => {
  const { deps, repository, adapter, account } = await setup();
  adapter.historyBehavior = "not_found";

  await reconcileAccountHistory(deps, account, "999", "req_1");

  const updated = await repository.getAccount("user_1", account.id);
  assert.equal(updated?.historyId, "999");
  assert.equal(repository.audit.at(-1)?.reasonCode, "FULL_RESYNC");
});

test("reconcileAccountHistory marks health on a provider error without throwing", async () => {
  const { deps, repository, adapter, account } = await setup();
  adapter.historyBehavior = "other_error";

  await reconcileAccountHistory(deps, account, "150", "req_1");

  const updated = await repository.getAccount("user_1", account.id);
  assert.equal(updated?.health, "provider_error");
  assert.equal(repository.audit.at(-1)?.decision, "blocked");
});

test("handleGmailPushNotification resolves the right account by subject hash and reconciles it", async () => {
  const { deps, repository, account } = await setup();
  const count = await handleGmailPushNotification(deps, "tester@example.com", "150", "req_1");
  assert.equal(count, 1);
  const updated = await repository.getAccount("user_1", account.id);
  assert.equal(updated?.historyId, "200");
});

test("handleGmailPushNotification is a no-op for an unknown Gmail address", async () => {
  const { deps } = await setup();
  const count = await handleGmailPushNotification(deps, "someone-else@example.com", "150", "req_1");
  assert.equal(count, 0);
});

test("renewWatchForAccount records the new expiration on success", async () => {
  const { deps, repository, account } = await setup();
  const ok = await renewWatchForAccount(deps, account, "projects/p/topics/t", "req_1");
  assert.equal(ok, true);
  const syncState = await repository.getSyncState(account.id);
  assert.equal(syncState?.health, "active");
  assert.ok(syncState?.watchExpiresAt);
});

test("renewWatchForAccount marks health on failure without throwing", async () => {
  const { deps, repository, adapter, account } = await setup();
  adapter.watchBehavior = "failure";
  const ok = await renewWatchForAccount(deps, account, "projects/p/topics/t", "req_1");
  assert.equal(ok, false);
  const syncState = await repository.getSyncState(account.id);
  assert.equal(syncState?.health, "provider_error");
});

test("renewAllWatches aggregates renewed/failed across every connected account", async () => {
  const { deps, repository, adapter } = await setup();
  const secondAccount: StoredMailAccount = {
    id: "account_2",
    userId: "user_2",
    provider: "gmail",
    providerSubjectHash: "hash_2",
    encryptedAddress: "sealed",
    credentialEnvelope: JSON.stringify(
      await deps.vault.seal("refresh-token-2", "relay-mail:credential:user_2:account_2:gmail:v1"),
    ),
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    paused: false,
    state: "connected",
    health: "healthy",
    historyId: "1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    disconnectedAt: null,
  };
  await repository.upsertAccount(secondAccount);

  const result = await renewAllWatches(deps, "projects/p/topics/t", "req_1");
  assert.equal(result.renewed, 2);
  assert.equal(result.failed, 0);
  assert.equal(adapter.watchCalls, 2);
});
