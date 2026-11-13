import assert from "node:assert/strict";
import test from "node:test";
import {
  grantAccountAccess,
  InstallationManagementError,
  listInstallationsForUser,
  recordInstallationContact,
  removeInstallation,
  renameInstallation,
  revokeAccountAccess,
  setInstallationRevoked,
} from "../../lib/relay/mcp/installation-service.ts";
import type { StoredMailAccount } from "../../lib/relay/repository.ts";
import { MemoryRepository } from "./support/memory-repository.ts";

const connectedAccount: StoredMailAccount = {
  id: "account_1",
  userId: "user_1",
  provider: "gmail",
  providerSubjectHash: "hash",
  encryptedAddress: "sealed-address",
  credentialEnvelope: "sealed-credential",
  scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
  paused: false,
  state: "connected",
  health: "healthy",
  historyId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  disconnectedAt: null,
};

test("first contact creates a zero-grant installation and audits the connection", async () => {
  const repository = new MemoryRepository();
  const installation = await recordInstallationContact(
    repository,
    "user_1",
    "clerk_client_1",
    "Claude",
    "req_1",
  );
  assert.equal(installation.revoked, false);
  assert.equal((await repository.listAccountGrants(installation.id)).length, 0);
  assert.equal(repository.audit.at(-1)?.operation, "installation.connect");
  assert.equal(repository.audit.at(-1)?.decision, "changed");

  const again = await recordInstallationContact(repository, "user_1", "clerk_client_1", "Claude", "req_2");
  assert.equal(again.id, installation.id);
  assert.equal(repository.audit.filter((event) => event.operation === "installation.connect").length, 1);
});

test("distinct client ids for the same user get distinct installations", async () => {
  const repository = new MemoryRepository();
  const a = await recordInstallationContact(repository, "user_1", "client_a", null, "req_1");
  const b = await recordInstallationContact(repository, "user_1", "client_b", null, "req_2");
  assert.notEqual(a.id, b.id);
  assert.equal((await listInstallationsForUser(repository, "user_1")).length, 2);
});

test("revoking an installation bumps its revocation epoch and audits the change", async () => {
  const repository = new MemoryRepository();
  const installation = await recordInstallationContact(repository, "user_1", "client_a", null, "req_1");
  const changed = await setInstallationRevoked(repository, "user_1", installation.id, true, "req_2");
  assert.equal(changed, true);
  const stored = await repository.getInstallation("user_1", installation.id);
  assert.equal(stored?.revoked, true);
  assert.equal(stored!.revocationEpoch > installation.revocationEpoch, true);
  assert.equal(repository.audit.at(-1)?.reasonCode, "INSTALLATION_REVOKED");
});

test("renaming a client changes only the owner's installation and writes a content-free audit event", async () => {
  const repository = new MemoryRepository();
  const installation = await recordInstallationContact(
    repository,
    "user_1",
    "client_a",
    "Claude",
    "req_1",
  );

  assert.equal(
    await renameInstallation(
      repository,
      "user_1",
      installation.id,
      "Work Claude",
      "req_2",
    ),
    true,
  );
  assert.equal(
    (await repository.getInstallation("user_1", installation.id))?.clientName,
    "Work Claude",
  );
  assert.equal(repository.audit.at(-1)?.operation, "installation.rename");
  assert.equal(repository.audit.at(-1)?.reasonCode, "INSTALLATION_RENAMED");
  assert.doesNotMatch(JSON.stringify(repository.audit.at(-1)), /Work Claude/);
  assert.equal(
    await renameInstallation(
      repository,
      "someone_else",
      installation.id,
      "Attacker name",
      "req_3",
    ),
    false,
  );
});

test("removing a client revokes it, clears every grant, and prevents restoration by omission", async () => {
  const repository = new MemoryRepository();
  repository.accounts.set(connectedAccount.id, connectedAccount);
  const installation = await recordInstallationContact(
    repository,
    "user_1",
    "client_a",
    "Claude",
    "req_1",
  );
  await grantAccountAccess(
    repository,
    "user_1",
    installation.id,
    connectedAccount.id,
    ["search"],
    "req_2",
  );

  assert.equal(
    await removeInstallation(repository, "user_1", installation.id, "req_3"),
    true,
  );
  assert.equal(
    (await repository.getInstallation("user_1", installation.id))?.revoked,
    true,
  );
  assert.deepEqual(await repository.listAccountGrants(installation.id), []);
  assert.equal(repository.audit.at(-1)?.reasonCode, "INSTALLATION_REMOVED");
});

test("granting rejects permissions that don't exist", async () => {
  const repository = new MemoryRepository();
  repository.accounts.set(connectedAccount.id, connectedAccount);
  const installation = await recordInstallationContact(repository, "user_1", "client_a", null, "req_1");

  await assert.rejects(
    () =>
      grantAccountAccess(repository, "user_1", installation.id, connectedAccount.id, ["archive"], "req_2"),
    (error: unknown) =>
      error instanceof InstallationManagementError && error.code === "PERMISSION_NOT_YET_AVAILABLE",
  );
});

test("granting send permission requires the account to already have compose scope, same as draft", async () => {
  const repository = new MemoryRepository();
  repository.accounts.set(connectedAccount.id, connectedAccount);
  const installation = await recordInstallationContact(repository, "user_1", "client_a", null, "req_1");

  await assert.rejects(
    () => grantAccountAccess(repository, "user_1", installation.id, connectedAccount.id, ["send"], "req_2"),
    (error: unknown) =>
      error instanceof InstallationManagementError && error.code === "COMPOSE_SCOPE_NOT_GRANTED",
  );

  const composeAccount = {
    ...connectedAccount,
    id: "account_compose_send",
    scopes: [...connectedAccount.scopes, "https://www.googleapis.com/auth/gmail.compose"],
  };
  repository.accounts.set(composeAccount.id, composeAccount);
  const grant = await grantAccountAccess(repository, "user_1", installation.id, composeAccount.id, ["send"], "req_3");
  assert.ok(grant);
  assert.equal(grant.permissions.send, true);
});

test("granting draft permission requires the account to already have compose scope", async () => {
  const repository = new MemoryRepository();
  repository.accounts.set(connectedAccount.id, connectedAccount);
  const installation = await recordInstallationContact(repository, "user_1", "client_a", null, "req_1");

  await assert.rejects(
    () => grantAccountAccess(repository, "user_1", installation.id, connectedAccount.id, ["draft"], "req_2"),
    (error: unknown) =>
      error instanceof InstallationManagementError && error.code === "COMPOSE_SCOPE_NOT_GRANTED",
  );

  const composeAccount = {
    ...connectedAccount,
    id: "account_compose",
    scopes: [...connectedAccount.scopes, "https://www.googleapis.com/auth/gmail.compose"],
  };
  repository.accounts.set(composeAccount.id, composeAccount);
  const grant = await grantAccountAccess(repository, "user_1", installation.id, composeAccount.id, ["draft"], "req_3");
  assert.ok(grant);
  assert.equal(grant.permissions.draft, true);
});

test("granting search/read_body persists a fail-closed-shaped permission set", async () => {
  const repository = new MemoryRepository();
  repository.accounts.set(connectedAccount.id, connectedAccount);
  const installation = await recordInstallationContact(repository, "user_1", "client_a", null, "req_1");

  const grant = await grantAccountAccess(
    repository,
    "user_1",
    installation.id,
    connectedAccount.id,
    ["search"],
    "req_2",
  );
  assert.ok(grant);
  assert.equal(grant.permissions.search, true);
  assert.equal(grant.permissions.read_body, false);
  assert.equal(grant.permissions.draft, false);
  assert.equal(grant.permissions.send, false);
  assert.equal(repository.audit.at(-1)?.reasonCode, "GRANT_UPDATED");
});

test("requesting zero permissions revokes any existing grant instead of persisting an all-false row", async () => {
  const repository = new MemoryRepository();
  repository.accounts.set(connectedAccount.id, connectedAccount);
  const installation = await recordInstallationContact(repository, "user_1", "client_a", null, "req_1");

  await grantAccountAccess(repository, "user_1", installation.id, connectedAccount.id, ["search"], "req_2");
  assert.ok(await repository.getAccountGrant(installation.id, connectedAccount.id));

  const grant = await grantAccountAccess(repository, "user_1", installation.id, connectedAccount.id, [], "req_3");
  assert.equal(grant, null);
  assert.equal(await repository.getAccountGrant(installation.id, connectedAccount.id), null);
  assert.equal(repository.audit.at(-1)?.reasonCode, "GRANT_REVOKED");
});

test("requesting zero permissions with no prior grant is a no-op, not an all-false row", async () => {
  const repository = new MemoryRepository();
  repository.accounts.set(connectedAccount.id, connectedAccount);
  const installation = await recordInstallationContact(repository, "user_1", "client_a", null, "req_1");

  const grant = await grantAccountAccess(repository, "user_1", installation.id, connectedAccount.id, [], "req_2");
  assert.equal(grant, null);
  assert.equal(await repository.getAccountGrant(installation.id, connectedAccount.id), null);
});

test("a grant cannot be created for another user's account", async () => {
  const repository = new MemoryRepository();
  repository.accounts.set(connectedAccount.id, { ...connectedAccount, userId: "someone_else" });
  const installation = await recordInstallationContact(repository, "user_1", "client_a", null, "req_1");

  await assert.rejects(
    () => grantAccountAccess(repository, "user_1", installation.id, connectedAccount.id, ["search"], "req_2"),
    (error: unknown) => error instanceof InstallationManagementError && error.code === "ACCOUNT_NOT_FOUND",
  );
});

test("an Outlook account can be granted search and read_body over MCP", async () => {
  const repository = new MemoryRepository();
  repository.accounts.set(connectedAccount.id, {
    ...connectedAccount,
    provider: "microsoft",
    scopes: ["Mail.Read"],
  });
  const installation = await recordInstallationContact(repository, "user_1", "client_a", null, "req_1");

  const grant = await grantAccountAccess(
    repository,
    "user_1",
    installation.id,
    connectedAccount.id,
    ["search", "read_body"],
    "req_2",
  );
  assert.ok(grant);
  assert.equal(grant.permissions.search, true);
  assert.equal(grant.permissions.read_body, true);
});

test("an Outlook account cannot be granted draft or send: it has no compose scope yet", async () => {
  const repository = new MemoryRepository();
  repository.accounts.set(connectedAccount.id, {
    ...connectedAccount,
    provider: "microsoft",
    scopes: ["Mail.Read"],
  });
  const installation = await recordInstallationContact(repository, "user_1", "client_a", null, "req_1");

  await assert.rejects(
    () => grantAccountAccess(repository, "user_1", installation.id, connectedAccount.id, ["draft"], "req_2"),
    (error: unknown) =>
      error instanceof InstallationManagementError && error.code === "COMPOSE_SCOPE_NOT_GRANTED",
  );
  assert.equal(await repository.getAccountGrant(installation.id, connectedAccount.id), null);
});

test("an Outlook account with Mail.ReadWrite and Mail.Send can be granted draft and send", async () => {
  const repository = new MemoryRepository();
  repository.accounts.set(connectedAccount.id, {
    ...connectedAccount,
    provider: "microsoft",
    scopes: ["Mail.Read", "Mail.ReadWrite", "Mail.Send"],
  });
  const installation = await recordInstallationContact(repository, "user_1", "client_a", null, "req_1");

  const grant = await grantAccountAccess(
    repository,
    "user_1",
    installation.id,
    connectedAccount.id,
    ["draft", "send"],
    "req_2",
  );
  assert.ok(grant);
  assert.equal(grant.permissions.draft, true);
  assert.equal(grant.permissions.send, true);
});

test("an Outlook account with only Mail.ReadWrite (no Mail.Send) still cannot be granted send", async () => {
  const repository = new MemoryRepository();
  repository.accounts.set(connectedAccount.id, {
    ...connectedAccount,
    provider: "microsoft",
    scopes: ["Mail.Read", "Mail.ReadWrite"],
  });
  const installation = await recordInstallationContact(repository, "user_1", "client_a", null, "req_1");

  await assert.rejects(
    () => grantAccountAccess(repository, "user_1", installation.id, connectedAccount.id, ["send"], "req_2"),
    (error: unknown) =>
      error instanceof InstallationManagementError && error.code === "COMPOSE_SCOPE_NOT_GRANTED",
  );
});

test("disconnecting an account crypto-shreds its address and clears its grants", async () => {
  const repository = new MemoryRepository();
  repository.accounts.set(connectedAccount.id, connectedAccount);
  const installation = await recordInstallationContact(repository, "user_1", "client_a", null, "req_1");
  await grantAccountAccess(repository, "user_1", installation.id, connectedAccount.id, ["search"], "req_2");
  assert.ok(await repository.getAccountGrant(installation.id, connectedAccount.id));

  await repository.finishDisconnect("user_1", connectedAccount.id, "disconnected");

  const stored = repository.accounts.get(connectedAccount.id);
  assert.equal(stored?.state, "disconnected");
  assert.equal(stored?.credentialEnvelope, null); // access credential destroyed
  assert.equal(stored?.encryptedAddress, ""); // address ciphertext destroyed
  assert.equal(await repository.getAccountGrant(installation.id, connectedAccount.id), null);
});

test("revoking a grant removes it and audits the change", async () => {
  const repository = new MemoryRepository();
  repository.accounts.set(connectedAccount.id, connectedAccount);
  const installation = await recordInstallationContact(repository, "user_1", "client_a", null, "req_1");
  await grantAccountAccess(repository, "user_1", installation.id, connectedAccount.id, ["search"], "req_2");

  const removed = await revokeAccountAccess(repository, "user_1", installation.id, connectedAccount.id, "req_3");
  assert.equal(removed, true);
  assert.equal(await repository.getAccountGrant(installation.id, connectedAccount.id), null);
  assert.equal(repository.audit.at(-1)?.reasonCode, "GRANT_REVOKED");
});

test("audit events for installation/grant operations never carry content-shaped fields", async () => {
  const repository = new MemoryRepository();
  repository.accounts.set(connectedAccount.id, connectedAccount);
  const installation = await recordInstallationContact(repository, "user_1", "client_a", "My Claude", "req_1");
  await grantAccountAccess(repository, "user_1", installation.id, connectedAccount.id, ["search", "read_body"], "req_2");
  await setInstallationRevoked(repository, "user_1", installation.id, true, "req_3");

  const serialized = JSON.stringify(repository.audit);
  assert.doesNotMatch(serialized, /My Claude/);
  assert.doesNotMatch(serialized, /gmail\.readonly/);
});
