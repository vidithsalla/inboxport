import assert from "node:assert/strict";
import test from "node:test";
import type { VaultReadyConfig } from "../../lib/relay/config.ts";
import { LocalEnvelopeVault } from "../../lib/relay/crypto.ts";
import { grantAccountAccess, recordInstallationContact } from "../../lib/relay/mcp/installation-service.ts";
import { McpMailAccessError, type McpToolDependencies } from "../../lib/relay/mcp/mail-tools-service.ts";
import { GmailAdapter } from "../../lib/relay/providers/gmail.ts";
import {
  OutlookApiError,
  type OutlookDraftContent,
  type OutlookDraftResult,
  type OutlookMessage,
  type OutlookProfile,
  type OutlookProvider,
  type OutlookSearchResult,
  type OutlookSendResult,
  type OutlookThread,
} from "../../lib/relay/providers/outlook.ts";
import type { StoredMailAccount } from "../../lib/relay/repository.ts";
import { listPendingApprovals, requestSendApproval, resolveSendApproval } from "../../lib/relay/send-approval-service.ts";
import { MemoryRepository } from "./support/memory-repository.ts";

/**
 * The Gmail suite in send-approval.test.ts already proves every
 * envelope-lifecycle rule (expiry, atomic transitions, deny/cancel,
 * content-changed abort) that send-approval-service.ts enforces regardless
 * of provider -- those don't need re-proving per provider. What's specific
 * to Outlook and does need its own coverage: the two-scope compose gate
 * (Mail.ReadWrite + Mail.Send, unlike Gmail's single scope), that dispatch
 * actually reaches the Outlook adapter rather than Gmail's, and that
 * OutlookApiError classifies into failed/delivery_unknown the same way
 * GmailApiError does.
 */

type SendBehavior = "success" | "rejected" | "server_error" | "ambiguous";

class FakeOutlookAdapter implements OutlookProvider {
  draft: OutlookDraftContent;
  sendBehavior: SendBehavior = "success";
  sendCalls = 0;

  constructor(draft: OutlookDraftContent) {
    this.draft = draft;
  }

  async getProfile(): Promise<OutlookProfile> {
    return { emailAddress: "tester@outlook.example.com" };
  }
  async search(): Promise<readonly OutlookSearchResult[]> {
    return [];
  }
  async getMessage(): Promise<OutlookMessage> {
    throw new Error("not used in these tests");
  }
  async getThread(): Promise<OutlookThread> {
    throw new Error("not used in these tests");
  }
  async createDraft(): Promise<OutlookDraftResult> {
    return { draftId: this.draft.draftId, providerMessageId: this.draft.draftId, threadId: this.draft.threadId };
  }
  async updateDraft(): Promise<OutlookDraftResult> {
    return { draftId: this.draft.draftId, providerMessageId: this.draft.draftId, threadId: this.draft.threadId };
  }
  async getDraft(): Promise<OutlookDraftContent> {
    return this.draft;
  }
  async sendDraft(): Promise<OutlookSendResult> {
    this.sendCalls += 1;
    if (this.sendBehavior === "rejected") throw new OutlookApiError("FORBIDDEN", 403);
    if (this.sendBehavior === "server_error") throw new OutlookApiError("UPSTREAM_FAILED", 500);
    if (this.sendBehavior === "ambiguous") throw new TypeError("fetch failed: network timeout");
    return { providerMessageId: this.draft.draftId, threadId: this.draft.threadId };
  }
}

const config: VaultReadyConfig = {
  appUrl: "http://localhost:3000",
  demoMode: true,
  autoMigrate: true,
  supportEmail: "support@example.com",
  allowedEmails: [],
  googleClientId: "client-id",
  googleClientSecret: "client-secret",
  microsoftClientId: "ms-client-id",
  microsoftClientSecret: "ms-client-secret",
  cookieKey: null,
  vaultKek: "test-vault-kek",
};

const draftContent: OutlookDraftContent = {
  draftId: "odraft_1",
  threadId: "oconv_1",
  from: "",
  to: "person@example.net",
  cc: "",
  bcc: "",
  subject: "Re: Contract",
  bodyText: "Hello there",
  bodyHtml: "",
  hasAttachments: false,
};

async function setup(overrides: Partial<OutlookDraftContent> = {}, scopes = ["Mail.Read", "Mail.ReadWrite", "Mail.Send"]) {
  const repository = new MemoryRepository();
  const vault = await LocalEnvelopeVault.fromEncodedKey(Buffer.alloc(32, 22).toString("base64url"));
  const adapter = new FakeOutlookAdapter({ ...draftContent, ...overrides });
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/token")) {
      return Response.json({ access_token: "short-access", expires_in: 3600, token_type: "Bearer" });
    }
    throw new Error("unexpected fetch");
  };
  const deps: McpToolDependencies = {
    repository,
    vault,
    config,
    adapters: { gmail: new GmailAdapter(), outlook: adapter },
    fetcher,
  };

  const credentialEnvelope = await vault.seal(
    "refresh-token",
    "relay-mail:credential:user_1:account_1:microsoft:v1",
  );
  const encryptedAddress = await vault.seal(
    "me@outlook.example.com",
    "relay-mail:address:user_1:account_1:microsoft:v1",
  );
  const account: StoredMailAccount = {
    id: "account_1",
    userId: "user_1",
    provider: "microsoft",
    providerSubjectHash: "hash",
    encryptedAddress: JSON.stringify(encryptedAddress),
    credentialEnvelope: JSON.stringify(credentialEnvelope),
    scopes,
    paused: false,
    state: "connected",
    health: "healthy",
    historyId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    disconnectedAt: null,
  };
  await repository.upsertAccount(account);

  await recordInstallationContact(repository, "user_1", "client_a", null, "req_setup");
  const [installation] = await repository.listInstallations("user_1");
  return { deps, repository, adapter, account, installation };
}

test("request approval is denied with only Mail.ReadWrite (missing Mail.Send)", async () => {
  const { deps, repository, installation, account } = await setup({}, ["Mail.Read", "Mail.ReadWrite"]);
  await repository.upsertAccountGrant(
    installation.id,
    account.id,
    { search: false, read_body: false, draft: false, send: true },
    { deniedLabelIds: [], maxResults: 50, maxBytes: 500_000 },
  );
  await assert.rejects(
    () => requestSendApproval(deps, "user_1", installation.id, "client_a", account.id, "odraft_1", "req_1"),
    (error: unknown) => error instanceof McpMailAccessError && error.code === "COMPOSE_SCOPE_NOT_GRANTED",
  );
});

test("a granted, compose-scoped Outlook account can request approval with no content in audit", async () => {
  const { deps, repository, installation, account } = await setup();
  await grantAccountAccess(repository, "user_1", installation.id, account.id, ["send"], "req_grant");

  const summary = await requestSendApproval(deps, "user_1", installation.id, "client_a", account.id, "odraft_1", "req_1");
  assert.ok(summary.approvalId);
  assert.equal(summary.preview.subject, "Re: Contract");
  assert.equal(summary.preview.to, "person@example.net");

  const consoleUrl = new URL(summary.consoleUrl);
  assert.equal(consoleUrl.searchParams.get("approval"), summary.approvalId);

  const serialized = JSON.stringify(repository.audit);
  assert.doesNotMatch(serialized, /Re: Contract|Hello there|person@example\.net/);

  const pending = await listPendingApprovals(deps, "user_1");
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.preview.subject, "Re: Contract");
});

test("request approval rejects an Outlook draft that currently has attachments", async () => {
  const { deps, repository, installation, account } = await setup({ hasAttachments: true });
  await grantAccountAccess(repository, "user_1", installation.id, account.id, ["send"], "req_grant");
  await assert.rejects(
    () => requestSendApproval(deps, "user_1", installation.id, "client_a", account.id, "odraft_1", "req_1"),
    (error: unknown) =>
      error instanceof McpMailAccessError && error.code === "ATTACHMENTS_NOT_SUPPORTED_IN_MVP",
  );
});

test("approving an Outlook approval dispatches to the Outlook adapter, not Gmail's", async () => {
  const { deps, repository, installation, account, adapter } = await setup();
  await grantAccountAccess(repository, "user_1", installation.id, account.id, ["send"], "req_grant");
  const summary = await requestSendApproval(deps, "user_1", installation.id, "client_a", account.id, "odraft_1", "req_1");

  const resolution = await resolveSendApproval(deps, "user_1", summary.approvalId, "approve", "req_2");
  assert.equal(resolution.state, "sent");
  assert.equal(resolution.providerMessageId, "odraft_1");
  assert.equal(adapter.sendCalls, 1);
  assert.equal(await repository.getApprovalEnvelope("user_1", summary.approvalId), null);

  const serialized = JSON.stringify(repository.audit);
  assert.doesNotMatch(serialized, /Re: Contract|Hello there/);
});

test("content changed in the Outlook draft after approval request aborts the send", async () => {
  const { deps, repository, installation, account, adapter } = await setup();
  await grantAccountAccess(repository, "user_1", installation.id, account.id, ["send"], "req_grant");
  const summary = await requestSendApproval(deps, "user_1", installation.id, "client_a", account.id, "odraft_1", "req_1");

  adapter.draft = { ...adapter.draft, subject: "Something else entirely" };

  await assert.rejects(
    () => resolveSendApproval(deps, "user_1", summary.approvalId, "approve", "req_2"),
    (error: unknown) => error instanceof McpMailAccessError && error.code === "CONTENT_CHANGED_SINCE_APPROVAL",
  );
  assert.equal(adapter.sendCalls, 0);
});

test("a definitive Outlook rejection marks the envelope failed, without retrying", async () => {
  const { deps, repository, installation, account, adapter } = await setup();
  await grantAccountAccess(repository, "user_1", installation.id, account.id, ["send"], "req_grant");
  const summary = await requestSendApproval(deps, "user_1", installation.id, "client_a", account.id, "odraft_1", "req_1");

  adapter.sendBehavior = "rejected";
  const resolution = await resolveSendApproval(deps, "user_1", summary.approvalId, "approve", "req_2");
  assert.equal(resolution.state, "failed");
  assert.equal(adapter.sendCalls, 1);
});

test("an Outlook 5xx during send is delivery_unknown, not failed", async () => {
  const { deps, repository, installation, account, adapter } = await setup();
  await grantAccountAccess(repository, "user_1", installation.id, account.id, ["send"], "req_grant");
  const summary = await requestSendApproval(deps, "user_1", installation.id, "client_a", account.id, "odraft_1", "req_1");

  adapter.sendBehavior = "server_error";
  const resolution = await resolveSendApproval(deps, "user_1", summary.approvalId, "approve", "req_2");
  assert.equal(resolution.state, "delivery_unknown");
  assert.equal(repository.approvals.get(summary.approvalId)?.state, "delivery_unknown");
});

test("an ambiguous (network-level) Outlook send failure is delivery_unknown and never auto-retried", async () => {
  const { deps, repository, installation, account, adapter } = await setup();
  await grantAccountAccess(repository, "user_1", installation.id, account.id, ["send"], "req_grant");
  const summary = await requestSendApproval(deps, "user_1", installation.id, "client_a", account.id, "odraft_1", "req_1");

  adapter.sendBehavior = "ambiguous";
  const resolution = await resolveSendApproval(deps, "user_1", summary.approvalId, "approve", "req_2");
  assert.equal(resolution.state, "delivery_unknown");
  assert.equal((await listPendingApprovals(deps, "user_1")).length, 0);
});
