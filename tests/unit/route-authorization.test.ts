import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { RuntimeConfig } from "../../lib/relay/config.ts";
import * as realConfigModule from "../../lib/relay/config.ts";
import { LocalEnvelopeVault } from "../../lib/relay/crypto.ts";
import { GmailReadOnlyService } from "../../lib/relay/gmail-service.ts";
import * as realRuntimeModule from "../../lib/relay/runtime.ts";
import type { RequestUser } from "../../lib/relay/request-user.ts";
import type { RelayRepository, StoredMailAccount } from "../../lib/relay/repository.ts";
import { MemoryRepository } from "./support/memory-repository.ts";

/**
 * Every mutating route (pause, disconnect, revoke installation, grant/revoke
 * account access, resolve an approval) resolves `user` from the request and
 * then calls a service method scoped by `user.id`. That scoping is already
 * unit-tested at the service layer -- what has never been exercised is the
 * route's own plumbing: does it actually pass the *authenticated* user's id
 * into that call, for a *real* Request object, rather than trusting
 * anything from the path or body? These tests exercise the real route
 * handlers end to end (real Request in, real Response out) with only
 * config/auth-resolution/runtime-construction mocked out, since those
 * require live infra (Clerk, Turso) this test suite never touches.
 */

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

let repository: RelayRepository = new MemoryRepository();
let currentUser: RequestUser | null = null;
const vaultKeyPromise = LocalEnvelopeVault.fromEncodedKey(Buffer.alloc(32, 7).toString("base64url"));

mock.module("../../lib/relay/config.ts", {
  namedExports: { ...realConfigModule, getRuntimeConfig: () => config },
});
// Not spreading the real module's exports here: request-user.ts imports
// @clerk/nextjs/server at module scope, which has a webpack-only resolution
// that breaks under Node's plain ESM loader. resolveRequestUser is the only
// export any of these routes actually use.
mock.module("../../lib/relay/request-user.ts", {
  namedExports: {
    resolveRequestUser: async () => currentUser,
    deriveRelayUserId: async (clerkUserId: string) => clerkUserId,
  },
});
mock.module("../../lib/relay/runtime.ts", {
  namedExports: {
    ...realRuntimeModule,
    getDataRuntime: async () => {
      const vault = await vaultKeyPromise;
      return { config, repository, vault };
    },
    getGmailRuntime: async () => {
      const vault = await vaultKeyPromise;
      return {
        config,
        repository,
        vault,
        cookieVault: vault,
        service: new GmailReadOnlyService(repository, vault, config),
      };
    },
  },
});

const { POST: pauseAccountRoute } = await import(
  "../../app/api/accounts/[accountId]/pause/route.ts"
);
const { DELETE: deleteAccountRoute } = await import("../../app/api/accounts/[accountId]/route.ts");
const { POST: revokeInstallationRoute } = await import(
  "../../app/api/installations/[installationId]/revoke/route.ts"
);
const { PATCH: renameInstallationRoute, DELETE: removeInstallationRoute } = await import(
  "../../app/api/installations/[installationId]/route.ts"
);
const { POST: grantRoute, DELETE: revokeGrantRoute } = await import(
  "../../app/api/installations/[installationId]/grants/[accountId]/route.ts"
);
const { POST: resolveApprovalRoute } = await import("../../app/api/approvals/[approvalId]/route.ts");
const { POST: feedbackRoute } = await import("../../app/api/feedback/route.ts");

const OWNER: RequestUser = { id: "owner", email: "owner@example.com" };
const ATTACKER: RequestUser = { id: "attacker", email: "attacker@example.com" };

const jsonRequest = (url: string, body: unknown): Request =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", origin: config.appUrl },
    body: JSON.stringify(body),
  });

const account = (overrides: Partial<StoredMailAccount> = {}): StoredMailAccount => ({
  id: "acc_1",
  userId: OWNER.id,
  provider: "gmail",
  providerSubjectHash: "hash",
  encryptedAddress: "encrypted",
  credentialEnvelope: "credential",
  scopes: [],
  paused: false,
  state: "connected",
  health: "healthy",
  historyId: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  disconnectedAt: null,
  ...overrides,
});

test("feedback accepts an omitted email and sends the trusted app referrer", async () => {
  currentUser = OWNER;
  const previousEndpoint = process.env.RELAY_FEEDBACK_ENDPOINT;
  const originalFetch = globalThis.fetch;
  process.env.RELAY_FEEDBACK_ENDPOINT = "https://formspree.io/f/test-form";
  const delivery: { body: Record<string, unknown> | null; redirect: RequestRedirect | undefined } = {
    body: null,
    redirect: undefined,
  };
  let deliveredReferrer = "";
  globalThis.fetch = (async (_input, init) => {
    delivery.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    delivery.redirect = init?.redirect;
    deliveredReferrer = new Headers(init?.headers).get("referer") ?? "";
    return Response.json({ ok: true });
  }) as typeof fetch;

  try {
    const response = await feedbackRoute(
      jsonRequest("http://localhost:3000/api/feedback", {
        feedback: "The approvals page needs more context.",
      }),
    );
    assert.equal(response.status, 201);
    assert.equal(delivery.body?.email, undefined);
    assert.equal(delivery.body?.feedback, "The approvals page needs more context.");
    assert.equal(deliveredReferrer, config.appUrl);
    assert.equal(delivery.redirect, "error");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousEndpoint === undefined) delete process.env.RELAY_FEEDBACK_ENDPOINT;
    else process.env.RELAY_FEEDBACK_ENDPOINT = previousEndpoint;
  }
});

test("feedback rejects an endpoint with embedded credentials", async () => {
  currentUser = OWNER;
  const previousEndpoint = process.env.RELAY_FEEDBACK_ENDPOINT;
  process.env.RELAY_FEEDBACK_ENDPOINT = "https://user:password@example.com/submit";
  try {
    const response = await feedbackRoute(
      jsonRequest("http://localhost:3000/api/feedback", { feedback: "Useful feedback" }),
    );
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, "FEEDBACK_NOT_CONFIGURED");
  } finally {
    if (previousEndpoint === undefined) delete process.env.RELAY_FEEDBACK_ENDPOINT;
    else process.env.RELAY_FEEDBACK_ENDPOINT = previousEndpoint;
  }
});

test("feedback remains compulsory", async () => {
  currentUser = OWNER;
  const response = await feedbackRoute(
    jsonRequest("http://localhost:3000/api/feedback", { email: "owner@example.com" }),
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "FEEDBACK_INVALID");
});

test("pausing another user's account 404s and leaves it unpaused", async () => {
  repository = new MemoryRepository();
  await repository.upsertAccount(account());
  currentUser = ATTACKER;

  const response = await pauseAccountRoute(
    jsonRequest("http://localhost:3000/api/accounts/acc_1/pause", { paused: true }),
  );
  assert.equal(response.status, 404);
  assert.equal((await repository.getAccount(OWNER.id, "acc_1"))?.paused, false);
});

test("disconnecting another user's account 404s and leaves it connected", async () => {
  repository = new MemoryRepository();
  await repository.upsertAccount(account());
  currentUser = ATTACKER;

  const response = await deleteAccountRoute(
    new Request("http://localhost:3000/api/accounts/acc_1", {
      method: "DELETE",
      headers: { origin: config.appUrl },
    }),
  );
  assert.equal(response.status, 404);
  assert.equal((await repository.getAccount(OWNER.id, "acc_1"))?.state, "connected");
});

test("revoking another user's installation 404s and leaves it unrevoked", async () => {
  repository = new MemoryRepository();
  currentUser = OWNER;
  const { installation } = await repository.getOrCreateInstallation(OWNER.id, "client_a", null);
  currentUser = ATTACKER;

  const response = await revokeInstallationRoute(
    jsonRequest(`http://localhost:3000/api/installations/${installation.id}/revoke`, { revoked: true }),
  );
  assert.equal(response.status, 404);
  assert.equal((await repository.getInstallation(OWNER.id, installation.id))?.revoked, false);
});

test("renaming another user's installation 404s and leaves its name unchanged", async () => {
  repository = new MemoryRepository();
  currentUser = OWNER;
  const { installation } = await repository.getOrCreateInstallation(
    OWNER.id,
    "client_a",
    "Claude",
  );
  currentUser = ATTACKER;

  const response = await renameInstallationRoute(
    new Request(`http://localhost:3000/api/installations/${installation.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: config.appUrl },
      body: JSON.stringify({ client_name: "Not mine" }),
    }),
  );
  assert.equal(response.status, 404);
  assert.equal(
    (await repository.getInstallation(OWNER.id, installation.id))?.clientName,
    "Claude",
  );
});

test("removing another user's installation 404s and leaves its access active", async () => {
  repository = new MemoryRepository();
  currentUser = OWNER;
  const { installation } = await repository.getOrCreateInstallation(
    OWNER.id,
    "client_a",
    "Claude",
  );
  currentUser = ATTACKER;

  const response = await removeInstallationRoute(
    new Request(`http://localhost:3000/api/installations/${installation.id}`, {
      method: "DELETE",
      headers: { origin: config.appUrl },
    }),
  );
  assert.equal(response.status, 404);
  assert.equal(
    (await repository.getInstallation(OWNER.id, installation.id))?.revoked,
    false,
  );
});

test("granting access on another user's installation 404s and creates no grant", async () => {
  repository = new MemoryRepository();
  currentUser = OWNER;
  const { installation } = await repository.getOrCreateInstallation(OWNER.id, "client_a", null);
  await repository.upsertAccount(account());
  currentUser = ATTACKER;

  const response = await grantRoute(
    jsonRequest(
      `http://localhost:3000/api/installations/${installation.id}/grants/acc_1`,
      { permissions: ["search"] },
    ),
  );
  assert.equal(response.status, 404);
  assert.equal(await repository.getAccountGrant(installation.id, "acc_1"), null);
});

test("revoking a grant on another user's installation 404s and leaves the grant intact", async () => {
  repository = new MemoryRepository();
  currentUser = OWNER;
  const { installation } = await repository.getOrCreateInstallation(OWNER.id, "client_a", null);
  await repository.upsertAccount(account());
  await repository.upsertAccountGrant(
    installation.id,
    "acc_1",
    { search: true },
    { deniedLabelIds: [], maxResults: 20, maxBytes: 500_000 },
  );
  currentUser = ATTACKER;

  const response = await revokeGrantRoute(
    new Request(`http://localhost:3000/api/installations/${installation.id}/grants/acc_1`, {
      method: "DELETE",
      headers: { origin: config.appUrl },
    }),
  );
  assert.equal(response.status, 404);
  assert.ok(await repository.getAccountGrant(installation.id, "acc_1"));
});

test("resolving another user's pending approval 404s and leaves it awaiting approval", async () => {
  repository = new MemoryRepository();
  await repository.createApprovalEnvelope({
    id: "approval_1",
    userId: OWNER.id,
    installationId: "installation_1",
    accountId: "acc_1",
    providerDraftId: "draft_1",
    payloadHash: "hash",
    encryptedEnvelope: "sealed",
    state: "awaiting_approval",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  });
  currentUser = ATTACKER;

  const response = await resolveApprovalRoute(
    jsonRequest("http://localhost:3000/api/approvals/approval_1", { decision: "approve" }),
  );
  assert.equal(response.status, 404);
  assert.equal((await repository.getApprovalEnvelope(OWNER.id, "approval_1"))?.state, "awaiting_approval");
});
