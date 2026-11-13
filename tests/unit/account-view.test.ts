import assert from "node:assert/strict";
import test from "node:test";
import { listPublicAccounts, pauseAccount } from "../../lib/relay/account-view.ts";
import { LocalEnvelopeVault, serializeEnvelope } from "../../lib/relay/crypto.ts";
import type { MailProvider, StoredMailAccount } from "../../lib/relay/repository.ts";
import { MemoryRepository } from "./support/memory-repository.ts";

const vaultPromise = LocalEnvelopeVault.fromEncodedKey(Buffer.alloc(32, 7).toString("base64url"));

async function storedAccount(
  vault: LocalEnvelopeVault,
  id: string,
  provider: MailProvider,
  address: string,
): Promise<StoredMailAccount> {
  const sealed = await vault.seal(address, `relay-mail:address:user_1:${id}:${provider}:v1`);
  return {
    id,
    userId: "user_1",
    provider,
    providerSubjectHash: `hash_${id}`,
    encryptedAddress: serializeEnvelope(sealed),
    credentialEnvelope: null,
    scopes: [],
    paused: false,
    state: "connected",
    health: "healthy",
    historyId: null,
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
    disconnectedAt: null,
  };
}

test("listPublicAccounts decrypts addresses for every provider without provider OAuth config", async () => {
  const vault = await vaultPromise;
  const repository = new MemoryRepository();
  const gmail = await storedAccount(vault, "acct_g", "gmail", "person@gmail.com");
  const outlook = await storedAccount(vault, "acct_o", "microsoft", "person@outlook.com");
  repository.accounts.set(gmail.id, gmail);
  repository.accounts.set(outlook.id, outlook);

  const listed = await listPublicAccounts(vault, repository, "user_1");
  const byId = Object.fromEntries(listed.map((a) => [a.id, a]));
  assert.equal(byId["acct_g"].address, "person@gmail.com");
  assert.equal(byId["acct_g"].provider, "gmail");
  assert.equal(byId["acct_o"].address, "person@outlook.com");
  assert.equal(byId["acct_o"].provider, "microsoft");
});

test("pauseAccount pauses any provider's account and writes a content-free audit event", async () => {
  const vault = await vaultPromise;
  const repository = new MemoryRepository();
  const outlook = await storedAccount(vault, "acct_o", "microsoft", "person@outlook.com");
  repository.accounts.set(outlook.id, outlook);

  const changed = await pauseAccount(repository, { id: "user_1", email: "o@x.com" }, "acct_o", true, "req_pause");
  assert.equal(changed, true);
  assert.equal(repository.accounts.get("acct_o")?.paused, true);
  assert.equal(repository.audit.at(-1)?.operation, "policy.update");
  assert.equal(repository.audit.at(-1)?.reasonCode, "POLICY_UPDATED");
});
