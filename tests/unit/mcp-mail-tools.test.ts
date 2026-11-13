import assert from "node:assert/strict";
import test from "node:test";
import type { VaultReadyConfig } from "../../lib/relay/config.ts";
import { LocalEnvelopeVault } from "../../lib/relay/crypto.ts";
import {
  McpMailAccessError,
  mcpCreateDraft,
  mcpGetMessage,
  mcpGetThread,
  mcpListGrantedAccounts,
  mcpSearch,
  mcpSearchMany,
  mcpUpdateDraft,
  type McpToolDependencies,
} from "../../lib/relay/mcp/mail-tools-service.ts";
import { grantAccountAccess, recordInstallationContact } from "../../lib/relay/mcp/installation-service.ts";
import type {
  GmailDraftContent,
  GmailDraftResult,
  GmailHistoryPage,
  GmailMessage,
  GmailProfile,
  GmailProvider,
  GmailSearchResult,
  GmailSendResult,
  GmailThread,
  GmailWatchResult,
} from "../../lib/relay/providers/gmail.ts";
import type {
  OutlookDraftContent,
  OutlookDraftResult,
  OutlookMessage,
  OutlookProfile,
  OutlookProvider,
  OutlookSearchResult,
  OutlookSendResult,
  OutlookThread,
} from "../../lib/relay/providers/outlook.ts";
import type { StoredMailAccount } from "../../lib/relay/repository.ts";
import { MemoryRepository } from "./support/memory-repository.ts";

const searchResult: GmailSearchResult = {
  id: "m1",
  threadId: "t1",
  internalDate: "1",
  from: "sender@example.net",
  subject: "Private subject",
  date: "today",
  snippet: "Private snippet",
  labelIds: ["INBOX"],
};

class FakeGmailAdapter implements GmailProvider {
  searchCalls = 0;
  async getProfile(): Promise<GmailProfile> {
    return { emailAddress: "tester@example.com", messagesTotal: 1, threadsTotal: 1, historyId: "1" };
  }
  async search(): Promise<readonly GmailSearchResult[]> {
    this.searchCalls += 1;
    return [searchResult];
  }
  async getMessage(): Promise<GmailMessage> {
    return { ...searchResult, to: "tester@example.com", cc: null, bodyText: "Private body", bodyTruncated: false };
  }
  async getThread(): Promise<GmailThread> {
    return { id: "t1", historyId: "1", messages: [await this.getMessage()] };
  }
  async createDraft(): Promise<GmailDraftResult> {
    return { draftId: "draft_1", providerMessageId: "m_draft_1", threadId: null };
  }
  async updateDraft(): Promise<GmailDraftResult> {
    return { draftId: "draft_1", providerMessageId: "m_draft_1", threadId: null };
  }
  async getDraft(): Promise<GmailDraftContent> {
    return {
      draftId: "draft_1",
      threadId: null,
      from: "",
      to: "tester@example.com",
      cc: "",
      bcc: "",
      subject: "Draft subject",
      bodyText: "Draft body",
      bodyHtml: "",
      hasAttachments: false,
    };
  }
  async sendDraft(): Promise<GmailSendResult> {
    return { providerMessageId: "m_draft_1", threadId: null };
  }
  async watch(): Promise<GmailWatchResult> {
    return { historyId: "100", expiration: String(Date.now() + 7 * 24 * 60 * 60 * 1000) };
  }
  async stopWatch(): Promise<void> {}
  async historyList(): Promise<GmailHistoryPage> {
    return { historyId: "100", recordCount: 0, nextPageToken: null };
  }
}

const outlookSearchResult: OutlookSearchResult = {
  id: "om1",
  threadId: "ot1",
  internalDate: "1",
  from: "sender@example.net",
  subject: "Private Outlook subject",
  date: "today",
  snippet: "Private Outlook preview",
};

class FakeOutlookAdapter implements OutlookProvider {
  searchCalls = 0;
  async getProfile(): Promise<OutlookProfile> {
    return { emailAddress: "tester@outlook.example.com" };
  }
  async search(): Promise<readonly OutlookSearchResult[]> {
    this.searchCalls += 1;
    return [outlookSearchResult];
  }
  async getMessage(): Promise<OutlookMessage> {
    return { ...outlookSearchResult, to: "tester@outlook.example.com", cc: null, bodyText: "Private Outlook body", bodyTruncated: false };
  }
  async getThread(): Promise<OutlookThread> {
    return { id: "ot1", messages: [await this.getMessage()] };
  }
  async createDraft(): Promise<OutlookDraftResult> {
    return { draftId: "odraft_1", providerMessageId: "odraft_1", threadId: null };
  }
  async updateDraft(): Promise<OutlookDraftResult> {
    return { draftId: "odraft_1", providerMessageId: "odraft_1", threadId: null };
  }
  async getDraft(): Promise<OutlookDraftContent> {
    return {
      draftId: "odraft_1",
      threadId: null,
      from: "",
      to: "tester@outlook.example.com",
      cc: "",
      bcc: "",
      subject: "Outlook draft subject",
      bodyText: "Outlook draft body",
      bodyHtml: "",
      hasAttachments: false,
    };
  }
  async sendDraft(): Promise<OutlookSendResult> {
    return { providerMessageId: "odraft_1", threadId: null };
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

const tokenFetcher: typeof fetch = async (input) => {
  const url = String(input);
  if (url.includes("/token")) {
    return Response.json({ access_token: "short-access", expires_in: 3600, token_type: "Bearer" });
  }
  throw new Error("unexpected fetch");
};

async function makeDeps(): Promise<{ deps: McpToolDependencies; repository: MemoryRepository }> {
  const repository = new MemoryRepository();
  const vault = await LocalEnvelopeVault.fromEncodedKey(Buffer.alloc(32, 9).toString("base64url"));
  return {
    deps: {
      repository,
      vault,
      config,
      adapters: { gmail: new FakeGmailAdapter(), outlook: new FakeOutlookAdapter() },
      fetcher: tokenFetcher,
    },
    repository,
  };
}

async function connectAccount(
  deps: McpToolDependencies,
  userId: string,
  accountId: string,
  scopes: readonly string[] = ["https://www.googleapis.com/auth/gmail.readonly"],
): Promise<StoredMailAccount> {
  const credentialEnvelope = await deps.vault.seal(
    "refresh-token",
    `relay-mail:credential:${userId}:${accountId}:gmail:v1`,
  );
  const encryptedAddress = await deps.vault.seal(
    "tester@example.com",
    `relay-mail:address:${userId}:${accountId}:gmail:v1`,
  );
  const account: StoredMailAccount = {
    id: accountId,
    userId,
    provider: "gmail",
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
  await deps.repository.upsertAccount(account);
  return account;
}

async function connectOutlookAccount(
  deps: McpToolDependencies,
  userId: string,
  accountId: string,
  scopes: readonly string[] = ["Mail.Read"],
): Promise<StoredMailAccount> {
  const credentialEnvelope = await deps.vault.seal(
    "refresh-token",
    `relay-mail:credential:${userId}:${accountId}:microsoft:v1`,
  );
  const encryptedAddress = await deps.vault.seal(
    "tester@outlook.example.com",
    `relay-mail:address:${userId}:${accountId}:microsoft:v1`,
  );
  const account: StoredMailAccount = {
    id: accountId,
    userId,
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
  await deps.repository.upsertAccount(account);
  return account;
}


test("an ungranted account is denied before any provider access", async () => {
  const { deps, repository } = await makeDeps();
  const account = await connectAccount(deps, "user_1", "account_1");
  await recordInstallationContact(repository, "user_1", "client_a", null, "req_1");
  const [installation] = await repository.listInstallations("user_1");

  await assert.rejects(
    () => mcpSearch(deps, "user_1", installation.id, "client_a", account.id, "q", 20, "req_2"),
    (error: unknown) => error instanceof McpMailAccessError && error.code === "ACCOUNT_NOT_GRANTED",
  );
  assert.equal((deps.adapters.gmail as FakeGmailAdapter).searchCalls, 0);
});

test("a granted account can be searched and audit carries no content", async () => {
  const { deps, repository } = await makeDeps();
  const account = await connectAccount(deps, "user_1", "account_1");
  await recordInstallationContact(repository, "user_1", "client_a", null, "req_1");
  const [installation] = await repository.listInstallations("user_1");
  await grantAccountAccess(repository, "user_1", installation.id, account.id, ["search", "read_body"], "req_2");

  const results = await mcpSearch(deps, "user_1", installation.id, "client_a", account.id, "private query", 20, "req_3");
  assert.equal(results[0]?.subject, "Private subject");

  const serialized = JSON.stringify(repository.audit);
  assert.doesNotMatch(serialized, /private query/i);
  assert.doesNotMatch(serialized, /private subject/i);
  assert.equal(repository.audit.at(-1)?.operation, "mail.search");
  assert.equal(repository.audit.at(-1)?.decision, "allowed");
});

test("search-only grant returns metadata but strips the body snippet", async () => {
  const { deps, repository } = await makeDeps();
  const account = await connectAccount(deps, "user_1", "account_1");
  await recordInstallationContact(repository, "user_1", "client_a", null, "req_1");
  const [installation] = await repository.listInstallations("user_1");
  await grantAccountAccess(repository, "user_1", installation.id, account.id, ["search"], "req_2");

  const results = await mcpSearch(deps, "user_1", installation.id, "client_a", account.id, "q", 20, "req_3");
  // Metadata still flows...
  assert.equal(results[0]?.subject, "Private subject");
  // ...but the body-derived snippet does not, because read_body is not granted.
  assert.equal(results[0]?.snippet, "");
});

test("search with read_body also granted includes the body snippet", async () => {
  const { deps, repository } = await makeDeps();
  const account = await connectAccount(deps, "user_1", "account_1");
  await recordInstallationContact(repository, "user_1", "client_a", null, "req_1");
  const [installation] = await repository.listInstallations("user_1");
  await grantAccountAccess(repository, "user_1", installation.id, account.id, ["search", "read_body"], "req_2");

  const results = await mcpSearch(deps, "user_1", installation.id, "client_a", account.id, "q", 20, "req_3");
  assert.equal(results[0]?.snippet, "Private snippet");
});

// The following two tests pin down that "could not determine grants" (a
// datastore failure) is never collapsed into the same shape as "confirmed the
// user has zero grants". The first must throw (the tool handler turns a throw
// into an isError result); the second must resolve to []. A future refactor
// that added a `catch { return []; }` anywhere in this path would fail the
// first test.
test("a grant-lookup datastore failure throws — it never degrades to an empty account list", async () => {
  const { deps, repository } = await makeDeps();
  const account = await connectAccount(deps, "user_1", "account_1");
  await recordInstallationContact(repository, "user_1", "client_a", null, "req_1");
  const [installation] = await repository.listInstallations("user_1");
  await grantAccountAccess(repository, "user_1", installation.id, account.id, ["search"], "req_2");

  // A valid, unpaused grant exists — but the datastore read itself fails.
  repository.listAccountGrants = async () => {
    throw new Error("ECONNREFUSED: datastore unreachable");
  };

  await assert.rejects(
    () => mcpListGrantedAccounts(deps, "user_1", installation.id),
    (error: unknown) => error instanceof Error && /unreachable/.test(error.message),
  );
});

test("a genuinely ungranted installation returns [] from a confirmed read, without error", async () => {
  const { deps, repository } = await makeDeps();
  await connectAccount(deps, "user_1", "account_1");
  await recordInstallationContact(repository, "user_1", "client_a", null, "req_1");
  const [installation] = await repository.listInstallations("user_1");

  const accounts = await mcpListGrantedAccounts(deps, "user_1", installation.id);
  assert.deepEqual(accounts, []);
});

test("revoking the installation denies every account immediately", async () => {
  const { deps, repository } = await makeDeps();
  const account = await connectAccount(deps, "user_1", "account_1");
  await recordInstallationContact(repository, "user_1", "client_a", null, "req_1");
  const [installation] = await repository.listInstallations("user_1");
  await grantAccountAccess(repository, "user_1", installation.id, account.id, ["search"], "req_2");
  await repository.setInstallationRevoked("user_1", installation.id, true);

  await assert.rejects(
    () => mcpSearch(deps, "user_1", installation.id, "client_a", account.id, "q", 20, "req_3"),
    (error: unknown) => error instanceof McpMailAccessError && error.code === "GLOBAL_PAUSE",
  );
});

test("a paused account is denied even with an active grant", async () => {
  const { deps, repository } = await makeDeps();
  const account = await connectAccount(deps, "user_1", "account_1");
  await repository.setAccountPaused("user_1", account.id, true);
  await recordInstallationContact(repository, "user_1", "client_a", null, "req_1");
  const [installation] = await repository.listInstallations("user_1");
  await grantAccountAccess(repository, "user_1", installation.id, account.id, ["search"], "req_2");

  await assert.rejects(
    () => mcpSearch(deps, "user_1", installation.id, "client_a", account.id, "q", 20, "req_3"),
    (error: unknown) => error instanceof McpMailAccessError && error.code === "ACCOUNT_PAUSED",
  );
});

test("one installation's grant does not leak to a different installation", async () => {
  const { deps, repository } = await makeDeps();
  const account = await connectAccount(deps, "user_1", "account_1");
  await recordInstallationContact(repository, "user_1", "client_a", null, "req_1");
  await recordInstallationContact(repository, "user_1", "client_b", null, "req_2");
  const [installationA, installationB] = await repository.listInstallations("user_1");
  await grantAccountAccess(repository, "user_1", installationA.id, account.id, ["search"], "req_3");

  await assert.rejects(
    () => mcpSearch(deps, "user_1", installationB.id, "client_b", account.id, "q", 20, "req_4"),
    (error: unknown) => error instanceof McpMailAccessError && error.code === "ACCOUNT_NOT_GRANTED",
  );
});

test("bounded multi-account search authorizes each account independently", async () => {
  const { deps, repository } = await makeDeps();
  const granted = await connectAccount(deps, "user_1", "account_granted");
  const ungranted = await connectAccount(deps, "user_1", "account_ungranted");
  await recordInstallationContact(repository, "user_1", "client_a", null, "req_1");
  const [installation] = await repository.listInstallations("user_1");
  await grantAccountAccess(repository, "user_1", installation.id, granted.id, ["search"], "req_2");

  const outcome = await mcpSearchMany(
    deps,
    "user_1",
    installation.id,
    "client_a",
    [granted.id, ungranted.id],
    "q",
    20,
    "req_3",
  );
  const grantedResult = outcome.find((entry) => entry.accountId === granted.id);
  const deniedResult = outcome.find((entry) => entry.accountId === ungranted.id);
  assert.equal(grantedResult?.ok, true);
  assert.equal(grantedResult?.results.length, 1);
  assert.equal(deniedResult?.ok, false);
  assert.equal(deniedResult?.errorCode, "ACCOUNT_NOT_GRANTED");
});

test("a successful MCP provider request clears a stale account health error", async () => {
  const { deps, repository } = await makeDeps();
  const account = await connectAccount(deps, "user_1", "account_1");
  await repository.setAccountHealth("user_1", account.id, "provider_error");
  await recordInstallationContact(repository, "user_1", "client_a", null, "req_1");
  const [installation] = await repository.listInstallations("user_1");
  await grantAccountAccess(repository, "user_1", installation.id, account.id, ["search"], "req_2");

  await mcpSearch(deps, "user_1", installation.id, "client_a", account.id, "q", 20, "req_3");

  assert.equal((await repository.getAccount("user_1", account.id))?.health, "healthy");
});

test("bounded multi-account search rejects more than five accounts", async () => {
  const { deps, repository } = await makeDeps();
  await recordInstallationContact(repository, "user_1", "client_a", null, "req_1");
  const [installation] = await repository.listInstallations("user_1");

  await assert.rejects(
    () =>
      mcpSearchMany(
        deps,
        "user_1",
        installation.id,
        "client_a",
        ["a1", "a2", "a3", "a4", "a5", "a6"],
        "q",
        20,
        "req_2",
      ),
    (error: unknown) => error instanceof McpMailAccessError && error.code === "TOO_MANY_ACCOUNTS",
  );
});

test("list_granted_accounts only returns accounts explicitly granted to this installation", async () => {
  const { deps, repository } = await makeDeps();
  const granted = await connectAccount(deps, "user_1", "account_granted");
  await connectAccount(deps, "user_1", "account_ungranted");
  await recordInstallationContact(repository, "user_1", "client_a", null, "req_1");
  const [installation] = await repository.listInstallations("user_1");
  await grantAccountAccess(repository, "user_1", installation.id, granted.id, ["search"], "req_2");

  const summaries = await mcpListGrantedAccounts(deps, "user_1", installation.id);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]?.accountId, granted.id);
  assert.equal(summaries[0]?.address, "tester@example.com");
});

test("a grant row with every permission false is excluded from list_granted_accounts, even if one exists", async () => {
  const { deps, repository } = await makeDeps();
  const account = await connectAccount(deps, "user_1", "account_all_false");
  await recordInstallationContact(repository, "user_1", "client_a", null, "req_1");
  const [installation] = await repository.listInstallations("user_1");
  // grantAccountAccess itself now refuses to persist this shape (see
  // mcp-installations.test.ts) -- this seeds the row directly to prove
  // mcpListGrantedAccounts also fails closed against one written any other
  // way, e.g. a row that predates that guard.
  await repository.upsertAccountGrant(
    installation.id,
    account.id,
    { search: false, read_body: false, draft: false, send: false },
    { deniedLabelIds: [], maxResults: 20, maxBytes: 500_000 },
  );

  const summaries = await mcpListGrantedAccounts(deps, "user_1", installation.id);
  assert.equal(summaries.length, 0);
});

test("rate limiting denies before token refresh and provider access", async () => {
  const { deps, repository } = await makeDeps();
  const account = await connectAccount(deps, "user_1", "account_1");
  await recordInstallationContact(repository, "user_1", "client_a", null, "req_1");
  const [installation] = await repository.listInstallations("user_1");
  await grantAccountAccess(repository, "user_1", installation.id, account.id, ["search"], "req_2");

  const original = repository.consumeRateLimit.bind(repository);
  repository.consumeRateLimit = async () => ({ allowed: false, remaining: 0, resetAt: "2026-07-21T12:01:00.000Z" });
  try {
    await assert.rejects(
      () => mcpSearch(deps, "user_1", installation.id, "client_a", account.id, "q", 20, "req_3"),
      (error: unknown) => error instanceof McpMailAccessError && error.code === "RATE_LIMITED",
    );
  } finally {
    repository.consumeRateLimit = original;
  }
  assert.equal((deps.adapters.gmail as FakeGmailAdapter).searchCalls, 0);
});

test("mcpGetMessage enforces the same per-account grant", async () => {
  const { deps, repository } = await makeDeps();
  const account = await connectAccount(deps, "user_1", "account_1");
  await recordInstallationContact(repository, "user_1", "client_a", null, "req_1");
  const [installation] = await repository.listInstallations("user_1");

  await assert.rejects(
    () => mcpGetMessage(deps, "user_1", installation.id, "client_a", account.id, "m1", "req_2"),
    (error: unknown) => error instanceof McpMailAccessError && error.code === "ACCOUNT_NOT_GRANTED",
  );

  await grantAccountAccess(repository, "user_1", installation.id, account.id, ["read_body"], "req_3");
  const message = await mcpGetMessage(deps, "user_1", installation.id, "client_a", account.id, "m1", "req_4");
  assert.equal(message.bodyText, "Private body");
});

const draftInput = {
  to: ["a@example.com"],
  cc: [],
  bcc: [],
  subject: "Hello",
  body: { format: "text" as const, content: "Body" },
};

test("draft creation is denied without a draft grant", async () => {
  const { deps, repository } = await makeDeps();
  const account = await connectAccount(deps, "user_1", "account_1", [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
  ]);
  await recordInstallationContact(repository, "user_1", "client_a", null, "req_1");
  const [installation] = await repository.listInstallations("user_1");
  await grantAccountAccess(repository, "user_1", installation.id, account.id, ["search"], "req_2");

  await assert.rejects(
    () => mcpCreateDraft(deps, "user_1", installation.id, "client_a", account.id, draftInput, "req_3"),
    (error: unknown) => error instanceof McpMailAccessError && error.code === "PERMISSION_DENIED",
  );
});

test("draft creation is denied if the account lacks compose scope even with a draft grant", async () => {
  const { deps, repository } = await makeDeps();
  const account = await connectAccount(deps, "user_1", "account_1"); // readonly only
  await recordInstallationContact(repository, "user_1", "client_a", null, "req_1");
  const [installation] = await repository.listInstallations("user_1");
  // Directly seed a draft grant, bypassing the console's own compose-scope gate,
  // to prove mail-tools-service enforces this independently at call time.
  await repository.upsertAccountGrant(
    installation.id,
    account.id,
    { search: true, read_body: true, draft: true, send: false },
    { deniedLabelIds: [], maxResults: 50, maxBytes: 500_000 },
  );

  await assert.rejects(
    () => mcpCreateDraft(deps, "user_1", installation.id, "client_a", account.id, draftInput, "req_2"),
    (error: unknown) => error instanceof McpMailAccessError && error.code === "COMPOSE_SCOPE_NOT_GRANTED",
  );
});

test("a granted, compose-scoped account can create and update a draft with no content in audit", async () => {
  const { deps, repository } = await makeDeps();
  const account = await connectAccount(deps, "user_1", "account_1", [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
  ]);
  await recordInstallationContact(repository, "user_1", "client_a", null, "req_1");
  const [installation] = await repository.listInstallations("user_1");
  await grantAccountAccess(repository, "user_1", installation.id, account.id, ["draft"], "req_2");

  const created = await mcpCreateDraft(deps, "user_1", installation.id, "client_a", account.id, draftInput, "req_3");
  assert.equal(created.draftId, "draft_1");

  const updated = await mcpUpdateDraft(
    deps,
    "user_1",
    installation.id,
    "client_a",
    account.id,
    created.draftId,
    { ...draftInput, subject: "Updated" },
    "req_4",
  );
  assert.equal(updated.providerMessageId, "m_draft_1");

  const serialized = JSON.stringify(repository.audit);
  assert.doesNotMatch(serialized, /a@example\.com/);
  assert.doesNotMatch(serialized, /Hello|Updated|Body/);
  assert.equal(repository.audit.filter((event) => event.operation === "mail.draft.create").length, 1);
  assert.equal(repository.audit.filter((event) => event.operation === "mail.draft.update").length, 1);
});

test("an Outlook account without Mail.ReadWrite/Mail.Send is denied at dispatch even with a seeded draft grant", async () => {
  const { deps, repository } = await makeDeps();
  const account = await connectOutlookAccount(deps, "user_1", "outlook_account_1", ["Mail.Read"]);
  await recordInstallationContact(repository, "user_1", "client_a", null, "req_1");
  const [installation] = await repository.listInstallations("user_1");
  // Directly seed a draft grant, bypassing grantAccountAccess's own
  // compose-scope gate, to prove mail-tools-service enforces this
  // independently at dispatch time too -- the same defense-in-depth
  // property already proven for Gmail above.
  await repository.upsertAccountGrant(
    installation.id,
    account.id,
    { search: true, read_body: true, draft: true, send: false },
    { deniedLabelIds: [], maxResults: 50, maxBytes: 500_000 },
  );

  await assert.rejects(
    () => mcpCreateDraft(deps, "user_1", installation.id, "client_a", account.id, draftInput, "req_2"),
    (error: unknown) => error instanceof McpMailAccessError && error.code === "COMPOSE_SCOPE_NOT_GRANTED",
  );
});

test("a granted, compose-scoped Outlook account creates and updates a draft dispatched to the Outlook adapter", async () => {
  const { deps, repository } = await makeDeps();
  const account = await connectOutlookAccount(deps, "user_1", "outlook_account_1", [
    "Mail.Read",
    "Mail.ReadWrite",
    "Mail.Send",
  ]);
  await recordInstallationContact(repository, "user_1", "client_a", null, "req_1");
  const [installation] = await repository.listInstallations("user_1");
  await grantAccountAccess(repository, "user_1", installation.id, account.id, ["draft"], "req_2");

  const created = await mcpCreateDraft(deps, "user_1", installation.id, "client_a", account.id, draftInput, "req_3");
  // odraft_1 only ever comes from FakeOutlookAdapter -- proves dispatch went
  // to the Outlook adapter, not Gmail's.
  assert.equal(created.draftId, "odraft_1");

  const updated = await mcpUpdateDraft(
    deps,
    "user_1",
    installation.id,
    "client_a",
    account.id,
    created.draftId,
    { ...draftInput, subject: "Updated" },
    "req_4",
  );
  assert.equal(updated.providerMessageId, "odraft_1");

  const serialized = JSON.stringify(repository.audit);
  assert.doesNotMatch(serialized, /a@example\.com/);
  assert.doesNotMatch(serialized, /Hello|Updated|Body/);
});

test("an ungranted Outlook account is denied before any provider access", async () => {
  const { deps, repository } = await makeDeps();
  const account = await connectOutlookAccount(deps, "user_1", "outlook_account_1");
  await recordInstallationContact(repository, "user_1", "client_a", null, "req_1");
  const [installation] = await repository.listInstallations("user_1");

  await assert.rejects(
    () => mcpSearch(deps, "user_1", installation.id, "client_a", account.id, "q", 20, "req_2"),
    (error: unknown) => error instanceof McpMailAccessError && error.code === "ACCOUNT_NOT_GRANTED",
  );
  assert.equal((deps.adapters.outlook as FakeOutlookAdapter).searchCalls, 0);
});

test("a granted Outlook account can be searched, message-read, and thread-read through MCP", async () => {
  const { deps, repository } = await makeDeps();
  const account = await connectOutlookAccount(deps, "user_1", "outlook_account_1");
  await recordInstallationContact(repository, "user_1", "client_a", null, "req_1");
  const [installation] = await repository.listInstallations("user_1");
  await grantAccountAccess(repository, "user_1", installation.id, account.id, ["search", "read_body"], "req_2");

  const results = await mcpSearch(deps, "user_1", installation.id, "client_a", account.id, "q", 20, "req_3");
  assert.equal(results[0]?.subject, "Private Outlook subject");
  assert.equal(results[0]?.snippet, "Private Outlook preview");

  const message = await mcpGetMessage(deps, "user_1", installation.id, "client_a", account.id, "om1", "req_4");
  assert.equal(message.bodyText, "Private Outlook body");

  const thread = await mcpGetThread(deps, "user_1", installation.id, "client_a", account.id, "ot1", "req_5");
  assert.equal(thread.messages.length, 1);

  const serialized = JSON.stringify(repository.audit);
  assert.doesNotMatch(serialized, /Private Outlook/i);
});

test("a search-only Outlook grant strips the body-derived snippet, same as Gmail", async () => {
  const { deps, repository } = await makeDeps();
  const account = await connectOutlookAccount(deps, "user_1", "outlook_account_1");
  await recordInstallationContact(repository, "user_1", "client_a", null, "req_1");
  const [installation] = await repository.listInstallations("user_1");
  await grantAccountAccess(repository, "user_1", installation.id, account.id, ["search"], "req_2");

  const results = await mcpSearch(deps, "user_1", installation.id, "client_a", account.id, "q", 20, "req_3");
  assert.equal(results[0]?.subject, "Private Outlook subject");
  assert.equal(results[0]?.snippet, "");
});

test("a granted Outlook account is listed with its decrypted address", async () => {
  const { deps, repository } = await makeDeps();
  const account = await connectOutlookAccount(deps, "user_1", "outlook_account_1");
  await recordInstallationContact(repository, "user_1", "client_a", null, "req_1");
  const [installation] = await repository.listInstallations("user_1");
  await grantAccountAccess(repository, "user_1", installation.id, account.id, ["search"], "req_2");

  const accounts = await mcpListGrantedAccounts(deps, "user_1", installation.id);
  assert.deepEqual(accounts, [
    {
      accountId: account.id,
      address: "tester@outlook.example.com",
      permissions: { search: true, read_body: false, draft: false, send: false },
      paused: false,
    },
  ]);
});

test("an Outlook account is denied with MICROSOFT_NOT_CONFIGURED when Microsoft credentials are absent", async () => {
  const { deps, repository } = await makeDeps();
  const account = await connectOutlookAccount(deps, "user_1", "outlook_account_1");
  await recordInstallationContact(repository, "user_1", "client_a", null, "req_1");
  const [installation] = await repository.listInstallations("user_1");
  await grantAccountAccess(repository, "user_1", installation.id, account.id, ["search"], "req_2");

  const unconfiguredDeps: McpToolDependencies = {
    ...deps,
    config: { ...deps.config, microsoftClientId: null, microsoftClientSecret: null },
  };

  await assert.rejects(
    () => mcpSearch(unconfiguredDeps, "user_1", installation.id, "client_a", account.id, "q", 20, "req_3"),
    (error: unknown) => error instanceof McpMailAccessError && error.code === "MICROSOFT_NOT_CONFIGURED",
  );
});

/**
 * McpToolDependencies.config only guarantees a vault key -- a Microsoft-only
 * deployment (no Google client id/secret at all) can still serve every MCP
 * tool for its Outlook accounts. This is the Gmail-side mirror of the
 * MICROSOFT_NOT_CONFIGURED case above: a Gmail account still fails cleanly
 * (not with a raw fetch to Google using null credentials) when Google isn't
 * configured, symmetric with how Outlook already behaved.
 */
test("a Gmail account is denied with GOOGLE_NOT_CONFIGURED when Google credentials are absent", async () => {
  const { deps, repository } = await makeDeps();
  const account = await connectAccount(deps, "user_1", "gmail_account_1");
  await recordInstallationContact(repository, "user_1", "client_a", null, "req_1");
  const [installation] = await repository.listInstallations("user_1");
  await grantAccountAccess(repository, "user_1", installation.id, account.id, ["search"], "req_2");

  const unconfiguredDeps: McpToolDependencies = {
    ...deps,
    config: { ...deps.config, googleClientId: null, googleClientSecret: null },
  };

  await assert.rejects(
    () => mcpSearch(unconfiguredDeps, "user_1", installation.id, "client_a", account.id, "q", 20, "req_3"),
    (error: unknown) => error instanceof McpMailAccessError && error.code === "GOOGLE_NOT_CONFIGURED",
  );
});
