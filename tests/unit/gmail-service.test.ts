import assert from "node:assert/strict";
import test from "node:test";
import { GMAIL_READONLY_SCOPE, type RuntimeConfig } from "../../lib/relay/config.ts";
import { LocalEnvelopeVault } from "../../lib/relay/crypto.ts";
import { GmailReadOnlyService } from "../../lib/relay/gmail-service.ts";
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
import { MemoryRepository } from "./support/memory-repository.ts";

const profile: GmailProfile = {
  emailAddress: "tester@example.com",
  messagesTotal: 1,
  threadsTotal: 1,
  historyId: "100",
};

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
  async getProfile() { return profile; }
  async search() { this.searchCalls += 1; return [searchResult]; }
  async getMessage(): Promise<GmailMessage> {
    return { ...searchResult, to: "tester@example.com", cc: null, bodyText: "Private body", bodyTruncated: false };
  }
  async getThread(): Promise<GmailThread> {
    return { id: "t1", historyId: "100", messages: [await this.getMessage()] };
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
  if (url.includes("/revoke")) return new Response(null, { status: 200 });
  throw new Error("unexpected fetch");
};

test("connect stores only encrypted address and refresh credential", async () => {
  const repository = new MemoryRepository();
  const vault = await LocalEnvelopeVault.fromEncodedKey(Buffer.alloc(32, 4).toString("base64url"));
  const service = new GmailReadOnlyService(repository, vault, config, new FakeGmailAdapter(), tokenFetcher);
  const user = { id: "user_1", email: "owner@example.com" };
  const connected = await service.connect(
    user,
    {
      accessToken: "initial-access",
      refreshToken: "private-refresh-token",
      expiresIn: 3600,
      scopes: [GMAIL_READONLY_SCOPE],
      tokenType: "Bearer",
    },
    "request_connect",
  );

  const stored = repository.accounts.get(connected.id);
  assert.ok(stored);
  assert.doesNotMatch(stored.encryptedAddress, /tester@example.com/);
  assert.doesNotMatch(stored.credentialEnvelope ?? "", /private-refresh-token/);
  assert.equal((await service.listAccounts(user))[0].address, "tester@example.com");
});

test("listAccounts returns only this provider's accounts, not a sibling provider's", async () => {
  const repository = new MemoryRepository();
  const vault = await LocalEnvelopeVault.fromEncodedKey(Buffer.alloc(32, 4).toString("base64url"));
  const service = new GmailReadOnlyService(repository, vault, config, new FakeGmailAdapter(), tokenFetcher);
  const user = { id: "user_1", email: "owner@example.com" };
  const gmail = await service.connect(
    user,
    {
      accessToken: "initial-access",
      refreshToken: "private-refresh-token",
      expiresIn: 3600,
      scopes: [GMAIL_READONLY_SCOPE],
      tokenType: "Bearer",
    },
    "request_connect",
  );

  // A connected Outlook account owned by the same user must not surface from
  // the Gmail service's list -- otherwise the console concatenates it with the
  // Outlook service's list and shows every Outlook inbox twice.
  const stored = repository.accounts.get(gmail.id);
  assert.ok(stored);
  repository.accounts.set("microsoft-account", {
    ...stored,
    id: "microsoft-account",
    provider: "microsoft",
    providerSubjectHash: "ms-subject-hash",
  });

  const listed = await service.listAccounts(user);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, gmail.id);
});

test("search is authorized, refreshes just in time, and audits no content", async () => {
  const repository = new MemoryRepository();
  const vault = await LocalEnvelopeVault.fromEncodedKey(Buffer.alloc(32, 5).toString("base64url"));
  const service = new GmailReadOnlyService(repository, vault, config, new FakeGmailAdapter(), tokenFetcher);
  const user = { id: "user_1", email: "owner@example.com" };
  const account = await service.connect(
    user,
    {
      accessToken: "initial-access",
      refreshToken: "private-refresh-token",
      expiresIn: 3600,
      scopes: [GMAIL_READONLY_SCOPE],
      tokenType: "Bearer",
    },
    "request_connect",
  );
  const results = await service.search(user, account.id, "private search query", 20, "request_search");
  assert.equal(results[0].subject, "Private subject");
  const serializedAudit = JSON.stringify(repository.audit);
  assert.doesNotMatch(serializedAudit, /private search query/i);
  assert.doesNotMatch(serializedAudit, /private subject/i);
  assert.doesNotMatch(serializedAudit, /private snippet/i);
  assert.equal(repository.audit.at(-1)?.operation, "mail.search");
});

test("paused account fails closed before Gmail access", async () => {
  const repository = new MemoryRepository();
  const vault = await LocalEnvelopeVault.fromEncodedKey(Buffer.alloc(32, 6).toString("base64url"));
  const service = new GmailReadOnlyService(repository, vault, config, new FakeGmailAdapter(), tokenFetcher);
  const user = { id: "user_1", email: "owner@example.com" };
  const account = await service.connect(
    user,
    {
      accessToken: "initial-access",
      refreshToken: "private-refresh-token",
      expiresIn: 3600,
      scopes: [GMAIL_READONLY_SCOPE],
      tokenType: "Bearer",
    },
    "request_connect",
  );
  await service.setPaused(user, account.id, true, "request_pause");
  await assert.rejects(
    () => service.search(user, account.id, "anything", 20, "request_search"),
    /ACCOUNT_PAUSED/,
  );
  assert.equal(repository.audit.at(-1)?.decision, "blocked");
});

test("rate limiting fails before token refresh and provider access", async () => {
  class RateLimitedRepository extends MemoryRepository {
    override async consumeRateLimit() {
      return {
        allowed: false,
        remaining: 0,
        resetAt: "2026-07-21T12:01:00.000Z",
      };
    }
  }
  const repository = new RateLimitedRepository();
  const vault = await LocalEnvelopeVault.fromEncodedKey(Buffer.alloc(32, 12).toString("base64url"));
  const adapter = new FakeGmailAdapter();
  let tokenRefreshes = 0;
  const countingFetcher: typeof fetch = async () => {
    tokenRefreshes += 1;
    return Response.json({ access_token: "short-access", expires_in: 3600 });
  };
  const service = new GmailReadOnlyService(repository, vault, config, adapter, countingFetcher);
  const user = { id: "user_1", email: "owner@example.com" };
  const account = await service.connect(
    user,
    {
      accessToken: "initial-access",
      refreshToken: "private-refresh-token",
      expiresIn: 3600,
      scopes: [GMAIL_READONLY_SCOPE],
      tokenType: "Bearer",
    },
    "request_connect",
  );
  await assert.rejects(
    () => service.search(user, account.id, "anything", 20, "request_search"),
    /RATE_LIMITED/,
  );
  assert.equal(tokenRefreshes, 0);
  assert.equal(adapter.searchCalls, 0);
  assert.equal(repository.audit.at(-1)?.providerResultClass, "rate_limited");
});
