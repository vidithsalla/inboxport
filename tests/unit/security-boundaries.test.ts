import assert from "node:assert/strict";
import test from "node:test";
import { assertAuditEventSafe, redactTelemetry } from "../../lib/relay/audit.ts";
import { hasValidMutationOrigin } from "../../lib/relay/api.ts";
import { assertAdapterContext } from "../../lib/relay/provider-adapter.ts";
import type { AuthorizationContext } from "../../lib/relay/contracts.ts";
import type { StoredAuditEvent } from "../../lib/relay/repository.ts";
import { MemoryRepository } from "./support/memory-repository.ts";

const context: AuthorizationContext = {
  tenantId: "tenant_1",
  userId: "user_1",
  installationId: "installation_1",
  clientId: "client_1",
  accountId: "account_personal",
  operation: "mail.search",
  policyVersion: 1,
  revocationEpoch: 1,
  constraints: { deniedLabelIds: [], maxResults: 10, maxBytes: 10_000 },
  issuedAt: "2026-07-21T12:00:00.000Z",
};

test("provider adapter rejects wrong-account context reuse", () => {
  assert.throws(
    () => assertAdapterContext(context, "account_work", "mail.search"),
    /ADAPTER_ACCOUNT_MISMATCH/,
  );
});

test("provider adapter rejects operation confusion", () => {
  assert.throws(
    () => assertAdapterContext(context, "account_personal", "mail.message.get"),
    /ADAPTER_OPERATION_MISMATCH/,
  );
});

test("audit guard rejects mail content and email addresses", () => {
  assert.throws(
    () => assertAuditEventSafe({ eventId: "event_1", query: "private search" }),
    /AUDIT_FIELD_FORBIDDEN:query/,
  );
  assert.throws(
    () => assertAuditEventSafe({ eventId: "person@example.com" }),
    /AUDIT_VALUE_FORBIDDEN:eventId/,
  );
});

test("the repository persistence boundary re-enforces the audit contract", async () => {
  const repository = new MemoryRepository();
  const base: StoredAuditEvent = {
    id: "event_1",
    occurredAt: "2026-07-21T12:00:00.000Z",
    userId: "user_1",
    installationId: "installation_1",
    accountId: "account_personal",
    operation: "mail.search",
    decision: "allowed",
    reasonCode: "OK",
    policyVersion: 1,
    requestId: "request_1",
    resultCount: 5,
    providerResultClass: "success",
  };
  // A safe, content-minimized event persists.
  await assert.doesNotReject(() => repository.appendAudit(base));
  // A leaked email address in any field is rejected at the boundary itself,
  // even though this bypasses the per-service builder guards.
  await assert.rejects(
    () => repository.appendAudit({ ...base, id: "person@example.com" }),
    /AUDIT_VALUE_FORBIDDEN/,
  );
});

test("audit guard accepts the content-minimized event contract", () => {
  assert.doesNotThrow(() =>
    assertAuditEventSafe({
      eventId: "event_1",
      occurredAt: "2026-07-21T12:00:00.000Z",
      tenantId: "tenant_1",
      userId: "user_1",
      installationId: "installation_1",
      accountId: "account_personal",
      operation: "mail.search",
      decision: "allowed",
      reasonCode: "OK",
      policyVersion: 1,
      requestId: "request_1",
      resultCount: 5,
      providerResultClass: "success",
    }),
  );
});

test("telemetry redaction removes nested content and credentials", () => {
  const redacted = redactTelemetry({
    requestId: "request_1",
    input: { query: "board acquisition", body: "secret" },
    authorization: "Bearer rly_live_secret",
    owner: "person@example.com",
  });

  assert.deepEqual(redacted, {
    requestId: "request_1",
    input: { query: "[REDACTED]", body: "[REDACTED]" },
    authorization: "[REDACTED]",
    owner: "[REDACTED]",
  });
});

test("state-changing routes require an exact same-origin request", () => {
  assert.equal(
    hasValidMutationOrigin(
      new Request("https://relay.example/api/accounts/a/pause", {
        method: "POST",
        headers: { origin: "https://relay.example" },
      }),
      "https://relay.example",
    ),
    true,
  );
  assert.equal(
    hasValidMutationOrigin(
      new Request("https://relay.example/api/accounts/a/pause", {
        method: "POST",
        headers: { origin: "https://attacker.example" },
      }),
      "https://relay.example",
    ),
    false,
  );
  assert.equal(
    hasValidMutationOrigin(
      new Request("https://preview-123.vercel.app/api/accounts/a/pause", {
        method: "POST",
        headers: { origin: "https://preview-123.vercel.app" },
      }),
      "https://relay.example",
    ),
    true,
  );
  assert.equal(
    hasValidMutationOrigin(
      new Request("https://relay.example/api/accounts/a/pause", { method: "POST" }),
      "https://relay.example",
    ),
    false,
  );
});
