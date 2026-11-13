import assert from "node:assert/strict";
import test from "node:test";
import type { VaultReadyConfig } from "../../lib/relay/config.ts";
import { LocalEnvelopeVault } from "../../lib/relay/crypto.ts";
import { grantAccountAccess, recordInstallationContact } from "../../lib/relay/mcp/installation-service.ts";
import { McpMailAccessError, type McpToolDependencies } from "../../lib/relay/mcp/mail-tools-service.ts";
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
import { OutlookAdapter } from "../../lib/relay/providers/outlook.ts";
import type { StoredMailAccount } from "../../lib/relay/repository.ts";
import { listPendingApprovals, requestSendApproval, resolveSendApproval } from "../../lib/relay/send-approval-service.ts";
import { MemoryRepository } from "./support/memory-repository.ts";

const GMAIL_COMPOSE_SCOPE = "https://www.googleapis.com/auth/gmail.compose";
const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

type SendBehavior =
  | "success"
  | "rejected"
  | "malformed_request"
  | "server_error"
  | "malformed_response"
  | "ambiguous";

class FakeGmailAdapter implements GmailProvider {
  draft: GmailDraftContent;
  sendBehavior: SendBehavior = "success";
  sendCalls = 0;

  constructor(draft: GmailDraftContent) {
    this.draft = draft;
  }

  async getProfile(): Promise<GmailProfile> {
    return { emailAddress: "tester@example.com", messagesTotal: 1, threadsTotal: 1, historyId: "1" };
  }
  async search(): Promise<readonly GmailSearchResult[]> {
    return [];
  }
  async getMessage(): Promise<GmailMessage> {
    throw new Error("not used in these tests");
  }
  async getThread(): Promise<GmailThread> {
    throw new Error("not used in these tests");
  }
  async createDraft(): Promise<GmailDraftResult> {
    return { draftId: this.draft.draftId, providerMessageId: "m_1", threadId: this.draft.threadId };
  }
  async updateDraft(): Promise<GmailDraftResult> {
    return { draftId: this.draft.draftId, providerMessageId: "m_1", threadId: this.draft.threadId };
  }
  async getDraft(): Promise<GmailDraftContent> {
    return this.draft;
  }
  async sendDraft(): Promise<GmailSendResult> {
    this.sendCalls += 1;
    // A definitive pre-delivery rejection: Gmail refused the request outright.
    if (this.sendBehavior === "rejected") throw new GmailApiError("FORBIDDEN", 403);
    // Also definitive: a 4xx the adapter couldn't map to a named code (e.g. Gmail's
    // 400 for a malformed raw message) still means Gmail rejected the request outright.
    if (this.sendBehavior === "malformed_request") throw new GmailApiError("UPSTREAM_FAILED", 400);
    // Ambiguous outcomes -- the message may already have been delivered.
    if (this.sendBehavior === "server_error") throw new GmailApiError("UPSTREAM_FAILED", 500);
    if (this.sendBehavior === "malformed_response") throw new GmailApiError("INVALID_RESPONSE", 502);
    if (this.sendBehavior === "ambiguous") throw new TypeError("fetch failed: network timeout");
    return { providerMessageId: "m_sent_1", threadId: this.draft.threadId };
  }
  async watch(): Promise<GmailWatchResult> {
    return { historyId: "100", expiration: String(Date.now() + 7 * 24 * 60 * 60 * 1000) };
  }
  async stopWatch(): Promise<void> {}
  async historyList(): Promise<GmailHistoryPage> {
    return { historyId: "100", recordCount: 0, nextPageToken: null };
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
  microsoftClientId: null,
  microsoftClientSecret: null,
  cookieKey: null,
  vaultKek: "test-vault-kek",
};

const draftContent: GmailDraftContent = {
  draftId: "draft_1",
  threadId: "thread_1",
  from: "",
  to: "person@example.net",
  cc: "",
  bcc: "",
  subject: "Re: Contract",
  bodyText: "Hello there",
  bodyHtml: "<p>Hello there</p>",
  hasAttachments: false,
};

async function setup(overrides: Partial<GmailDraftContent> = {}) {
  const repository = new MemoryRepository();
  const vault = await LocalEnvelopeVault.fromEncodedKey(Buffer.alloc(32, 21).toString("base64url"));
  const adapter = new FakeGmailAdapter({ ...draftContent, ...overrides });
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/token")) {
      return Response.json({ access_token: "short-access", expires_in: 3600, token_type: "Bearer" });
    }
    throw new Error("unexpected fetch");
  };
  // This file's fixtures are Gmail-only; adapters.outlook is unused here and
  // exists only to satisfy McpToolDependencies's shape.
  const deps: McpToolDependencies = {
    repository,
    vault,
    config,
    adapters: { gmail: adapter, outlook: new OutlookAdapter() },
    fetcher,
  };

  const credentialEnvelope = await vault.seal("refresh-token", "relay-mail:credential:user_1:account_1:gmail:v1");
  const encryptedAddress = await vault.seal("me@example.com", "relay-mail:address:user_1:account_1:gmail:v1");
  const account: StoredMailAccount = {
    id: "account_1",
    userId: "user_1",
    provider: "gmail",
    providerSubjectHash: "hash",
    encryptedAddress: JSON.stringify(encryptedAddress),
    credentialEnvelope: JSON.stringify(credentialEnvelope),
    scopes: [GMAIL_READONLY_SCOPE, GMAIL_COMPOSE_SCOPE],
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

test("request approval is denied without a send grant", async () => {
  const { deps, installation, account } = await setup();
  await assert.rejects(
    () => requestSendApproval(deps, "user_1", installation.id, "client_a", account.id, "draft_1", "req_1"),
    (error: unknown) => error instanceof McpMailAccessError && error.code === "ACCOUNT_NOT_GRANTED",
  );
});

test("request approval is denied without compose scope even with a send grant", async () => {
  const { deps, repository, installation, account } = await setup();
  const readonlyOnly = { ...account, scopes: [GMAIL_READONLY_SCOPE] };
  await repository.upsertAccount(readonlyOnly);
  // Bypass the console's own gate to prove mail-tools-service enforces this independently.
  await repository.upsertAccountGrant(
    installation.id,
    account.id,
    { search: false, read_body: false, draft: false, send: true },
    { deniedLabelIds: [], maxResults: 50, maxBytes: 500_000 },
  );
  await assert.rejects(
    () => requestSendApproval(deps, "user_1", installation.id, "client_a", account.id, "draft_1", "req_1"),
    (error: unknown) => error instanceof McpMailAccessError && error.code === "COMPOSE_SCOPE_NOT_GRANTED",
  );
});

test("request approval rejects a draft that currently has attachments", async () => {
  const { deps, repository, installation, account } = await setup({ hasAttachments: true });
  await grantAccountAccess(repository, "user_1", installation.id, account.id, ["send"], "req_grant");
  await assert.rejects(
    () => requestSendApproval(deps, "user_1", installation.id, "client_a", account.id, "draft_1", "req_1"),
    (error: unknown) =>
      error instanceof McpMailAccessError && error.code === "ATTACHMENTS_NOT_SUPPORTED_IN_MVP",
  );
  assert.equal((await repository.listApprovalEnvelopes("user_1")).length, 0);
});

test("a granted, compose-scoped account can request approval with no content in audit", async () => {
  const { deps, repository, installation, account } = await setup();
  await grantAccountAccess(repository, "user_1", installation.id, account.id, ["send"], "req_grant");

  const summary = await requestSendApproval(deps, "user_1", installation.id, "client_a", account.id, "draft_1", "req_1");
  assert.ok(summary.approvalId);
  assert.equal(summary.preview.subject, "Re: Contract");

  const consoleUrl = new URL(summary.consoleUrl);
  assert.equal(consoleUrl.origin, "http://localhost:3000");
  assert.equal(consoleUrl.searchParams.get("view"), "approvals");
  assert.equal(consoleUrl.searchParams.get("approval"), summary.approvalId);
  // The link is pure navigation convenience: it must carry no content, and
  // must point at the same page an unrelated approval would use, differing
  // only by the approval id in the query string.
  assert.doesNotMatch(summary.consoleUrl, /Re: Contract|Hello there|person@example\.net/);

  const serialized = JSON.stringify(repository.audit);
  assert.doesNotMatch(serialized, /Re: Contract|Hello there|person@example\.net/);
  assert.equal(repository.audit.at(-1)?.operation, "mail.send.request_approval");
  assert.equal(repository.audit.at(-1)?.decision, "allowed");

  const pending = await listPendingApprovals(deps, "user_1");
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.preview.subject, "Re: Contract");
  assert.equal(pending[0]?.preview.to, "person@example.net");
});

/**
 * Codex audit finding: every approval for the same user/account previously
 * used the identical vault context (userId+accountId only), with no binding
 * to the approval's own id. Two encrypted envelope rows for the same
 * account could be swapped at the storage layer and both would still
 * decrypt -- approval A's page could display approval B's reviewed content.
 * The context now also binds the approval id, so a swapped ciphertext must
 * fail authentication rather than silently open under the wrong row.
 */
test("swapping encrypted envelope ciphertext between two approvals on the same account fails to decrypt", async () => {
  const { deps, repository, installation, account } = await setup();
  await grantAccountAccess(repository, "user_1", installation.id, account.id, ["send"], "req_grant");

  const first = await requestSendApproval(deps, "user_1", installation.id, "client_a", account.id, "draft_1", "req_1");
  const second = await requestSendApproval(deps, "user_1", installation.id, "client_a", account.id, "draft_1", "req_2");

  const firstStored = repository.approvals.get(first.approvalId)!;
  const secondStored = repository.approvals.get(second.approvalId)!;
  // Swap ciphertexts between the two rows for the same account.
  repository.approvals.set(first.approvalId, { ...firstStored, encryptedEnvelope: secondStored.encryptedEnvelope });
  repository.approvals.set(second.approvalId, { ...secondStored, encryptedEnvelope: firstStored.encryptedEnvelope });

  await assert.rejects(() => listPendingApprovals(deps, "user_1"));
});

/**
 * Codex audit finding: canonicalizeDraft's hash covers BOTH bodyText and
 * bodyHtml, but the preview previously showed only one (plaintext,
 * preferred). If the two ever diverge -- a draft edited to have genuinely
 * different plaintext vs. HTML content, e.g. via the provider's own UI after
 * Relay created it -- a human could approve a hash that covers content they
 * never saw. This proves the fix: both must appear in what the human is
 * shown, in both the initial preview and the pending-approvals list (which
 * independently reconstructs the preview from the stored envelope).
 */
test("a draft with genuinely different plaintext and HTML bodies shows both to the approver, not just one", async () => {
  const { deps, repository, installation, account } = await setup({
    bodyText: "Approve this simple update.",
    bodyHtml: "<p>Wire the deposit to a different account this time.</p>",
  });
  await grantAccountAccess(repository, "user_1", installation.id, account.id, ["send"], "req_grant");

  const summary = await requestSendApproval(deps, "user_1", installation.id, "client_a", account.id, "draft_1", "req_1");
  assert.match(summary.preview.body.content, /Approve this simple update\./);
  assert.match(summary.preview.body.content, /Wire the deposit to a different account this time\./);

  const pending = await listPendingApprovals(deps, "user_1");
  assert.match(pending[0]!.preview.body.content, /Approve this simple update\./);
  assert.match(pending[0]!.preview.body.content, /Wire the deposit to a different account this time\./);
});

test("expiry is bounded to ten minutes", async () => {
  const { deps, repository, installation, account } = await setup();
  await grantAccountAccess(repository, "user_1", installation.id, account.id, ["send"], "req_grant");
  const before = Date.now();
  const summary = await requestSendApproval(deps, "user_1", installation.id, "client_a", account.id, "draft_1", "req_1");
  const ttlMs = new Date(summary.expiresAt).getTime() - before;
  assert.ok(ttlMs <= 10 * 60 * 1000 + 1000);
  assert.ok(ttlMs > 9 * 60 * 1000);
});

test("deny transitions to denied and deletes the envelope; it cannot be resolved twice", async () => {
  const { deps, repository, installation, account } = await setup();
  await grantAccountAccess(repository, "user_1", installation.id, account.id, ["send"], "req_grant");
  const summary = await requestSendApproval(deps, "user_1", installation.id, "client_a", account.id, "draft_1", "req_1");

  const resolution = await resolveSendApproval(deps, "user_1", summary.approvalId, "deny", "req_2");
  assert.equal(resolution.state, "denied");
  assert.equal(await repository.getApprovalEnvelope("user_1", summary.approvalId), null);

  await assert.rejects(
    () => resolveSendApproval(deps, "user_1", summary.approvalId, "deny", "req_3"),
    (error: unknown) => error instanceof McpMailAccessError && error.code === "APPROVAL_NOT_FOUND",
  );
});

test("cancel transitions to cancelled and deletes the envelope", async () => {
  const { deps, repository, installation, account } = await setup();
  await grantAccountAccess(repository, "user_1", installation.id, account.id, ["send"], "req_grant");
  const summary = await requestSendApproval(deps, "user_1", installation.id, "client_a", account.id, "draft_1", "req_1");

  const resolution = await resolveSendApproval(deps, "user_1", summary.approvalId, "cancel", "req_2");
  assert.equal(resolution.state, "cancelled");
  assert.equal(await repository.getApprovalEnvelope("user_1", summary.approvalId), null);
});

test("approving re-fetches, re-hashes, and dispatches only on a clean match", async () => {
  const { deps, repository, installation, account, adapter } = await setup();
  await grantAccountAccess(repository, "user_1", installation.id, account.id, ["send"], "req_grant");
  const summary = await requestSendApproval(deps, "user_1", installation.id, "client_a", account.id, "draft_1", "req_1");

  const resolution = await resolveSendApproval(deps, "user_1", summary.approvalId, "approve", "req_2");
  assert.equal(resolution.state, "sent");
  assert.equal(resolution.providerMessageId, "m_sent_1");
  assert.equal(adapter.sendCalls, 1);
  assert.equal(await repository.getApprovalEnvelope("user_1", summary.approvalId), null);

  const serialized = JSON.stringify(repository.audit);
  assert.doesNotMatch(serialized, /Re: Contract|Hello there/);
  assert.equal(repository.audit.at(-1)?.operation, "mail.send.dispatch");
  assert.equal(repository.audit.at(-1)?.decision, "allowed");
});

/**
 * Codex audit finding: the inner try/catch around sendDraft also wrapped the
 * post-send bookkeeping (transition to "sent", delete, audit). A repository
 * failure in that bookkeeping -- after the provider already confirmed the
 * send -- fell into the same catch as a send failure and could get
 * reclassified as failed/delivery_unknown, potentially erasing the one
 * record meant to survive exactly this kind of failure. The provider's own
 * confirmation must be the only thing that decides "sent" -- a database
 * hiccup afterward must never undo that.
 */
test("a repository failure after a confirmed successful send still reports sent, not failed or delivery_unknown", async () => {
  const { deps, repository, installation, account, adapter } = await setup();
  await grantAccountAccess(repository, "user_1", installation.id, account.id, ["send"], "req_grant");
  const summary = await requestSendApproval(deps, "user_1", installation.id, "client_a", account.id, "draft_1", "req_1");

  const realTransition = repository.transitionApprovalEnvelope.bind(repository);
  repository.transitionApprovalEnvelope = async (userId, id, fromStates, toState, notExpiredAsOf) => {
    if (toState === "sent") throw new Error("ECONNRESET: Turso unreachable");
    return realTransition(userId, id, fromStates, toState, notExpiredAsOf);
  };

  const resolution = await resolveSendApproval(deps, "user_1", summary.approvalId, "approve", "req_2");
  assert.equal(resolution.state, "sent");
  assert.equal(resolution.providerMessageId, "m_sent_1");
  assert.equal(adapter.sendCalls, 1);
});

test("content changed after approval request aborts the send instead of sending stale-approved content", async () => {
  const { deps, repository, installation, account, adapter } = await setup();
  await grantAccountAccess(repository, "user_1", installation.id, account.id, ["send"], "req_grant");
  const summary = await requestSendApproval(deps, "user_1", installation.id, "client_a", account.id, "draft_1", "req_1");

  // Simulate the user editing the draft directly in Gmail after the AI proposed it.
  adapter.draft = { ...adapter.draft, subject: "Something else entirely" };

  await assert.rejects(
    () => resolveSendApproval(deps, "user_1", summary.approvalId, "approve", "req_2"),
    (error: unknown) =>
      error instanceof McpMailAccessError && error.code === "CONTENT_CHANGED_SINCE_APPROVAL",
  );
  assert.equal(adapter.sendCalls, 0);
  assert.equal(await repository.getApprovalEnvelope("user_1", summary.approvalId), null);
});

test("a definitive provider rejection marks the envelope failed and deletes it, without retrying", async () => {
  const { deps, repository, installation, account, adapter } = await setup();
  await grantAccountAccess(repository, "user_1", installation.id, account.id, ["send"], "req_grant");
  const summary = await requestSendApproval(deps, "user_1", installation.id, "client_a", account.id, "draft_1", "req_1");

  adapter.sendBehavior = "rejected";
  const resolution = await resolveSendApproval(deps, "user_1", summary.approvalId, "approve", "req_2");
  assert.equal(resolution.state, "failed");
  assert.equal(adapter.sendCalls, 1);
  assert.equal(await repository.getApprovalEnvelope("user_1", summary.approvalId), null);
});

test("a 400 with an unmapped UPSTREAM_FAILED code is still classified failed, not delivery_unknown", async () => {
  const { deps, repository, installation, account, adapter } = await setup();
  await grantAccountAccess(repository, "user_1", installation.id, account.id, ["send"], "req_grant");
  const summary = await requestSendApproval(deps, "user_1", installation.id, "client_a", account.id, "draft_1", "req_1");

  adapter.sendBehavior = "malformed_request";
  const resolution = await resolveSendApproval(deps, "user_1", summary.approvalId, "approve", "req_2");
  assert.equal(resolution.state, "failed");
  assert.equal(adapter.sendCalls, 1);
  assert.equal(await repository.getApprovalEnvelope("user_1", summary.approvalId), null);
});

test("a provider 5xx during send is delivery_unknown, not failed -- Gmail may have sent it", async () => {
  const { deps, repository, installation, account, adapter } = await setup();
  await grantAccountAccess(repository, "user_1", installation.id, account.id, ["send"], "req_grant");
  const summary = await requestSendApproval(deps, "user_1", installation.id, "client_a", account.id, "draft_1", "req_1");

  adapter.sendBehavior = "server_error";
  const resolution = await resolveSendApproval(deps, "user_1", summary.approvalId, "approve", "req_2");
  assert.equal(resolution.state, "delivery_unknown");
  assert.equal(adapter.sendCalls, 1);
  // Retained (not deleted) and no longer pending, so it is never auto-retried.
  assert.equal(repository.approvals.get(summary.approvalId)?.state, "delivery_unknown");
  assert.equal((await listPendingApprovals(deps, "user_1")).length, 0);
});

test("a malformed 2xx send response is delivery_unknown, not failed", async () => {
  const { deps, repository, installation, account, adapter } = await setup();
  await grantAccountAccess(repository, "user_1", installation.id, account.id, ["send"], "req_grant");
  const summary = await requestSendApproval(deps, "user_1", installation.id, "client_a", account.id, "draft_1", "req_1");

  adapter.sendBehavior = "malformed_response";
  const resolution = await resolveSendApproval(deps, "user_1", summary.approvalId, "approve", "req_2");
  assert.equal(resolution.state, "delivery_unknown");
  assert.equal(repository.approvals.get(summary.approvalId)?.state, "delivery_unknown");
});

test("an ambiguous (network-level) send failure is marked delivery_unknown, kept, and never auto-retried", async () => {
  const { deps, repository, installation, account, adapter } = await setup();
  await grantAccountAccess(repository, "user_1", installation.id, account.id, ["send"], "req_grant");
  const summary = await requestSendApproval(deps, "user_1", installation.id, "client_a", account.id, "draft_1", "req_1");

  adapter.sendBehavior = "ambiguous";
  const resolution = await resolveSendApproval(deps, "user_1", summary.approvalId, "approve", "req_2");
  assert.equal(resolution.state, "delivery_unknown");
  assert.equal(adapter.sendCalls, 1);

  // The envelope is retained (not deleted) but is no longer "awaiting_approval", so it never
  // resurfaces for a fresh approve/deny/cancel decision or in the pending list.
  const stillThere = repository.approvals.get(summary.approvalId);
  assert.equal(stillThere?.state, "delivery_unknown");
  assert.equal((await listPendingApprovals(deps, "user_1")).length, 0);
  await assert.rejects(
    () => resolveSendApproval(deps, "user_1", summary.approvalId, "approve", "req_3"),
    (error: unknown) => error instanceof McpMailAccessError && error.code === "APPROVAL_NOT_PENDING",
  );
});

test("revoking the grant between request and approval cancels dispatch instead of sending", async () => {
  const { deps, repository, installation, account, adapter } = await setup();
  await grantAccountAccess(repository, "user_1", installation.id, account.id, ["send"], "req_grant");
  const summary = await requestSendApproval(deps, "user_1", installation.id, "client_a", account.id, "draft_1", "req_1");

  await repository.revokeAccountGrant(installation.id, account.id);

  await assert.rejects(
    () => resolveSendApproval(deps, "user_1", summary.approvalId, "approve", "req_2"),
    (error: unknown) => error instanceof McpMailAccessError && error.code === "ACCOUNT_NOT_GRANTED",
  );
  assert.equal(adapter.sendCalls, 0);
  assert.equal(await repository.getApprovalEnvelope("user_1", summary.approvalId), null);
});

test("revoking the installation between request and approval cancels dispatch instead of sending", async () => {
  const { deps, repository, installation, account, adapter } = await setup();
  await grantAccountAccess(repository, "user_1", installation.id, account.id, ["send"], "req_grant");
  const summary = await requestSendApproval(deps, "user_1", installation.id, "client_a", account.id, "draft_1", "req_1");

  await repository.setInstallationRevoked("user_1", installation.id, true);

  await assert.rejects(
    () => resolveSendApproval(deps, "user_1", summary.approvalId, "approve", "req_2"),
    (error: unknown) => error instanceof McpMailAccessError && error.code === "GLOBAL_PAUSE",
  );
  assert.equal(adapter.sendCalls, 0);
});

test("an expired approval is treated as gone and excluded from the pending list", async () => {
  const { deps, repository, installation, account } = await setup();
  await grantAccountAccess(repository, "user_1", installation.id, account.id, ["send"], "req_grant");
  const summary = await requestSendApproval(deps, "user_1", installation.id, "client_a", account.id, "draft_1", "req_1");

  const stored = repository.approvals.get(summary.approvalId)!;
  repository.approvals.set(summary.approvalId, {
    ...stored,
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });

  assert.equal(await repository.getApprovalEnvelope("user_1", summary.approvalId), null);
  assert.equal((await listPendingApprovals(deps, "user_1")).length, 0);
  await assert.rejects(
    () => resolveSendApproval(deps, "user_1", summary.approvalId, "approve", "req_2"),
    (error: unknown) => error instanceof McpMailAccessError && error.code === "APPROVAL_NOT_FOUND",
  );
});

test("the forward transition is atomic with expiry (closes the read-then-dispatch race)", async () => {
  const { deps, repository, installation, account } = await setup();
  await grantAccountAccess(repository, "user_1", installation.id, account.id, ["send"], "req_grant");
  const summary = await requestSendApproval(deps, "user_1", installation.id, "client_a", account.id, "draft_1", "req_1");

  // Simulate the envelope aging past its window after it was read as valid.
  const stored = repository.approvals.get(summary.approvalId)!;
  repository.approvals.set(summary.approvalId, {
    ...stored,
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });

  // With the expiry guard, the forward transition refuses to advance...
  assert.equal(
    await repository.transitionApprovalEnvelope(
      "user_1",
      summary.approvalId,
      ["awaiting_approval"],
      "approved",
      new Date().toISOString(),
    ),
    false,
  );
  // ...and it is the expiry, not the state, doing the blocking: the same
  // transition without the guard would have matched on state alone.
  assert.equal(
    await repository.transitionApprovalEnvelope("user_1", summary.approvalId, ["awaiting_approval"], "approved"),
    true,
  );
});
