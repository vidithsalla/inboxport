import assert from "node:assert/strict";
import test from "node:test";
import type {
  RelayRepository,
  StoredApprovalEnvelope,
  StoredMailAccount,
} from "../../lib/relay/repository.ts";
import { MemoryRepository } from "./support/memory-repository.ts";
import { createSqliteRepository } from "./support/sqlite-repository-harness.ts";

/**
 * Every test in defineSharedConformance runs against both implementations of
 * RelayRepository: the hand-written MemoryRepository fake every other unit
 * test uses, and a real LibsqlRelayRepository against an in-process libsql
 * database. Before this file, LibsqlRelayRepository -- what production
 * actually runs -- had zero direct tests; every guarantee (grants, pause,
 * revocation, the single-use approval transition) was only ever proven about
 * the fake. Rate limiting is intentionally excluded here: MemoryRepository's
 * consumeRateLimit is a permissive stub (`allowed: true` unconditionally),
 * not a real implementation, so there is no shared behavior to assert --
 * see the sqlite-only rate limit tests at the bottom of this file instead.
 */
function defineSharedConformance(
  label: string,
  makeRepository: () => Promise<RelayRepository>,
) {
  const account = (overrides: Partial<StoredMailAccount> = {}): StoredMailAccount => ({
    id: overrides.id ?? crypto.randomUUID(),
    userId: "user_1",
    provider: "gmail",
    providerSubjectHash: "hash_1",
    encryptedAddress: "encrypted_address",
    credentialEnvelope: "encrypted_credential",
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    paused: false,
    state: "connected",
    health: "healthy",
    historyId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    disconnectedAt: null,
    ...overrides,
  });

  const envelope = (overrides: Partial<StoredApprovalEnvelope> = {}): StoredApprovalEnvelope => ({
    id: overrides.id ?? crypto.randomUUID(),
    userId: "user_1",
    installationId: "installation_1",
    accountId: "account_1",
    providerDraftId: "draft_1",
    payloadHash: "hash",
    encryptedEnvelope: "sealed",
    state: "awaiting_approval",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    ...overrides,
  });

  test(`[${label}] an account is scoped strictly to its owning user`, async () => {
    const repository = await makeRepository();
    await repository.upsertAccount(account({ id: "acc_1" }));
    assert.ok(await repository.getAccount("user_1", "acc_1"));
    assert.equal(await repository.getAccount("someone_else", "acc_1"), null);
  });

  test(`[${label}] pause and health updates return false for a nonexistent account`, async () => {
    const repository = await makeRepository();
    assert.equal(await repository.setAccountPaused("user_1", "missing", true), false);
    assert.equal(await repository.setAccountHealth("user_1", "missing", "provider_error"), false);
  });

  test(`[${label}] pause and health updates persist and are readable back`, async () => {
    const repository = await makeRepository();
    await repository.upsertAccount(account({ id: "acc_1" }));
    assert.equal(await repository.setAccountPaused("user_1", "acc_1", true), true);
    assert.equal((await repository.getAccount("user_1", "acc_1"))?.paused, true);
    assert.equal(
      await repository.setAccountHealth("user_1", "acc_1", "reauthorization_required"),
      true,
    );
    assert.equal(
      (await repository.getAccount("user_1", "acc_1"))?.health,
      "reauthorization_required",
    );
  });

  test(`[${label}] finishDisconnect(disconnected) shreds the credential and clears grants`, async () => {
    const repository = await makeRepository();
    await repository.upsertAccount(account({ id: "acc_1" }));
    await repository.upsertAccountGrant(
      "installation_1",
      "acc_1",
      { search: true },
      { deniedLabelIds: [], maxResults: 20, maxBytes: 500_000 },
    );

    assert.equal(await repository.finishDisconnect("user_1", "acc_1", "disconnected"), true);

    const disconnected = await repository.getAccount("user_1", "acc_1");
    assert.equal(disconnected?.state, "disconnected");
    assert.equal(disconnected?.credentialEnvelope, null);
    assert.equal(disconnected?.encryptedAddress, "");
    assert.equal(await repository.getAccountGrant("installation_1", "acc_1"), null);
  });

  test(`[${label}] finishDisconnect(revocation_pending) keeps the credential`, async () => {
    const repository = await makeRepository();
    await repository.upsertAccount(account({ id: "acc_1" }));
    assert.equal(
      await repository.finishDisconnect("user_1", "acc_1", "revocation_pending"),
      true,
    );
    const pending = await repository.getAccount("user_1", "acc_1");
    assert.equal(pending?.state, "revocation_pending");
    assert.equal(pending?.credentialEnvelope, "encrypted_credential");
  });

  test(`[${label}] provider subject lookups are scoped by provider and user`, async () => {
    const repository = await makeRepository();
    await repository.upsertAccount(account({ id: "acc_1", provider: "gmail", providerSubjectHash: "h1" }));
    await repository.upsertAccount(
      account({ id: "acc_2", userId: "user_2", provider: "microsoft", providerSubjectHash: "h1" }),
    );

    assert.equal(
      (await repository.findAccountByProviderSubject("user_1", "gmail", "h1"))?.id,
      "acc_1",
    );
    assert.equal(await repository.findAccountByProviderSubject("user_1", "microsoft", "h1"), null);
    assert.equal(
      (await repository.findAccountsByProviderSubjectHash("microsoft", "h1")).length,
      1,
    );
    assert.equal((await repository.listAllConnectedAccounts("gmail")).length, 1);
  });

  test(`[${label}] a paused account is excluded from both background-sync lookups`, async () => {
    const repository = await makeRepository();
    await repository.upsertAccount(
      account({ id: "acc_active", userId: "user_1", provider: "gmail", providerSubjectHash: "h1", paused: false }),
    );
    await repository.upsertAccount(
      account({ id: "acc_paused", userId: "user_2", provider: "gmail", providerSubjectHash: "h1", paused: true }),
    );

    const bySubjectHash = await repository.findAccountsByProviderSubjectHash("gmail", "h1");
    assert.deepEqual(
      bySubjectHash.map((a) => a.id).sort(),
      ["acc_active"],
    );

    const allConnected = await repository.listAllConnectedAccounts("gmail");
    assert.deepEqual(
      allConnected.map((a) => a.id).sort(),
      ["acc_active"],
    );
  });

  test(`[${label}] getOrCreateInstallation is idempotent per user+client`, async () => {
    const repository = await makeRepository();
    const first = await repository.getOrCreateInstallation("user_1", "client_a", "Claude");
    const second = await repository.getOrCreateInstallation("user_1", "client_a", "Claude");
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(first.installation.id, second.installation.id);
  });

  test(`[${label}] revoking an installation advances its revocation epoch`, async () => {
    const repository = await makeRepository();
    const { installation } = await repository.getOrCreateInstallation("user_1", "client_a", null);
    assert.equal(await repository.setInstallationRevoked("user_1", installation.id, true), true);
    const revoked = await repository.getInstallation("user_1", installation.id);
    assert.equal(revoked?.revoked, true);
    assert.equal(revoked?.revocationEpoch, installation.revocationEpoch + 1);
  });

  test(`[${label}] renaming an installation is scoped to its owning user`, async () => {
    const repository = await makeRepository();
    const { installation } = await repository.getOrCreateInstallation(
      "user_1",
      "client_a",
      "Claude",
    );
    assert.equal(
      await repository.setInstallationName("someone_else", installation.id, "Wrong"),
      false,
    );
    assert.equal(
      await repository.setInstallationName("user_1", installation.id, "Work Claude"),
      true,
    );
    assert.equal(
      (await repository.getInstallation("user_1", installation.id))?.clientName,
      "Work Claude",
    );
  });

  test(`[${label}] account grants upsert in place and can be revoked`, async () => {
    const repository = await makeRepository();
    await repository.upsertAccountGrant(
      "installation_1",
      "acc_1",
      { search: true },
      { deniedLabelIds: [], maxResults: 20, maxBytes: 500_000 },
    );
    await repository.upsertAccountGrant(
      "installation_1",
      "acc_1",
      { search: true, read_body: true },
      { deniedLabelIds: [], maxResults: 20, maxBytes: 500_000 },
    );

    const grants = await repository.listAccountGrants("installation_1");
    assert.equal(grants.length, 1);
    assert.equal(grants[0]?.permissions.read_body, true);

    assert.equal(await repository.revokeAccountGrant("installation_1", "acc_1"), true);
    assert.equal(await repository.getAccountGrant("installation_1", "acc_1"), null);
    assert.equal(await repository.revokeAccountGrant("installation_1", "acc_1"), false);
  });

  test(`[${label}] an expired approval envelope is inaccessible and opportunistically deleted`, async () => {
    const repository = await makeRepository();
    await repository.createApprovalEnvelope(
      envelope({ id: "env_1", expiresAt: new Date(Date.now() - 1000).toISOString() }),
    );
    assert.equal(await repository.getApprovalEnvelope("user_1", "env_1"), null);
    assert.deepEqual(await repository.listApprovalEnvelopes("user_1"), []);
  });

  test(`[${label}] transitionApprovalEnvelope only succeeds from an allowed state`, async () => {
    const repository = await makeRepository();
    await repository.createApprovalEnvelope(envelope({ id: "env_1", state: "awaiting_approval" }));

    assert.equal(
      await repository.transitionApprovalEnvelope("user_1", "env_1", ["approved"], "dispatching"),
      false,
    );
    assert.equal(
      await repository.transitionApprovalEnvelope("user_1", "env_1", ["awaiting_approval"], "approved"),
      true,
    );
    assert.equal((await repository.getApprovalEnvelope("user_1", "env_1"))?.state, "approved");
  });

  test(`[${label}] transitionApprovalEnvelope respects notExpiredAsOf`, async () => {
    const repository = await makeRepository();
    const expiresAt = new Date(Date.now() + 1000).toISOString();
    await repository.createApprovalEnvelope(envelope({ id: "env_1", expiresAt }));

    const asOfAfterExpiry = new Date(Date.now() + 5000).toISOString();
    assert.equal(
      await repository.transitionApprovalEnvelope(
        "user_1",
        "env_1",
        ["awaiting_approval"],
        "approved",
        asOfAfterExpiry,
      ),
      false,
    );
  });

  test(`[${label}] exactly one of many concurrent transitions from the same state wins`, async () => {
    const repository = await makeRepository();
    await repository.createApprovalEnvelope(envelope({ id: "env_1", state: "awaiting_approval" }));

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        repository.transitionApprovalEnvelope("user_1", "env_1", ["awaiting_approval"], "approved"),
      ),
    );
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal((await repository.getApprovalEnvelope("user_1", "env_1"))?.state, "approved");
  });

  test(`[${label}] deleteApprovalEnvelope only removes envelopes owned by that user`, async () => {
    const repository = await makeRepository();
    await repository.createApprovalEnvelope(envelope({ id: "env_1" }));
    await repository.deleteApprovalEnvelope("someone_else", "env_1");
    assert.ok(await repository.getApprovalEnvelope("user_1", "env_1"));
    await repository.deleteApprovalEnvelope("user_1", "env_1");
    assert.equal(await repository.getApprovalEnvelope("user_1", "env_1"), null);
  });
}

defineSharedConformance("memory", async () => new MemoryRepository());
defineSharedConformance("sqlite", () => createSqliteRepository());

test("[sqlite] consumeRateLimit enforces the limit within a window", async () => {
  const repository = await createSqliteRepository();
  const now = new Date();
  const results = [];
  for (let i = 0; i < 5; i++) {
    results.push(await repository.consumeRateLimit("user_1", "acc_1", "mail.search", 3, 60, now));
  }
  assert.deepEqual(
    results.map((r) => r.allowed),
    [true, true, true, false, false],
  );
});

test("[sqlite] consumeRateLimit resolves concurrent increments without losing updates", async () => {
  const repository = await createSqliteRepository();
  const now = new Date();
  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      repository.consumeRateLimit("user_1", "acc_1", "mail.search", 10, 60, now),
    ),
  );
  // Twenty concurrent increments against a limit of 10 must allow exactly
  // 10 -- a lost update (two calls reading the same pre-increment count)
  // would let more than 10 through.
  assert.equal(results.filter((r) => r.allowed).length, 10);
});
