import assert from "node:assert/strict";
import test from "node:test";
import type { PolicySnapshot, RelayIdentity } from "../../lib/relay/contracts.ts";
import { authorize } from "../../lib/relay/policy.ts";

const identity: RelayIdentity = {
  tenantId: "tenant_1",
  userId: "user_1",
  installationId: "installation_1",
  clientId: "https://client.example/metadata.json",
};

const snapshot: PolicySnapshot = {
  tenantId: "tenant_1",
  userId: "user_1",
  installationId: "installation_1",
  policyVersion: 12,
  revocationEpoch: 4,
  globallyPaused: false,
  accounts: [
    {
      accountId: "account_personal",
      paused: false,
      permissions: { search: true, read_body: true, draft: false, send: false },
      constraints: { deniedLabelIds: [], maxResults: 25, maxBytes: 200_000 },
    },
  ],
};

test("allows a granted operation and binds the account to its context", () => {
  const decision = authorize(
    { identity, accountId: "account_personal", operation: "mail.search" },
    snapshot,
    new Date("2026-07-21T12:00:00.000Z"),
  );

  assert.equal(decision.allowed, true);
  if (decision.allowed) {
    assert.equal(decision.context.accountId, "account_personal");
    assert.equal(decision.context.policyVersion, 12);
    assert.equal(decision.context.issuedAt, "2026-07-21T12:00:00.000Z");
  }
});

test("fails closed for an account not explicitly granted", () => {
  const decision = authorize(
    { identity, accountId: "account_work", operation: "mail.search" },
    snapshot,
  );
  assert.deepEqual(decision, { allowed: false, code: "ACCOUNT_NOT_GRANTED" });
});

test("denies draft and send when only search/read are granted", () => {
  for (const operation of [
    "mail.draft.create",
    "mail.send.request_approval",
    "mail.send.dispatch",
  ] as const) {
    assert.deepEqual(authorize({ identity, accountId: "account_personal", operation }, snapshot), {
      allowed: false,
      code: "PERMISSION_DENIED",
    });
  }
});

test("rejects stale revocation epochs", () => {
  const decision = authorize(
    {
      identity,
      accountId: "account_personal",
      operation: "mail.search",
      observedRevocationEpoch: 3,
    },
    snapshot,
  );
  assert.deepEqual(decision, { allowed: false, code: "STALE_AUTHORIZATION" });
});

test("rejects identity and installation confusion", () => {
  const decision = authorize(
    {
      identity: { ...identity, installationId: "installation_attacker" },
      accountId: "account_personal",
      operation: "mail.search",
    },
    snapshot,
  );
  assert.deepEqual(decision, { allowed: false, code: "IDENTITY_MISMATCH" });
});
