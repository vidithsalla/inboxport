import assert from "node:assert/strict";
import test from "node:test";
import {
  filterAuditEvents,
  mapPublicAccounts,
  presentAuditEvent,
  serializeAuditEvents,
  type AuditEvent,
} from "../../app/console-model.ts";

const event = (decision: AuditEvent["decision"], id = decision): AuditEvent => ({
  id,
  occurredAt: "2026-07-26T12:00:00.000Z",
  installationId: "installation_1",
  accountId: "account_1",
  operation: "mail.search",
  decision,
  reasonCode: decision === "blocked" ? "ACCOUNT_PAUSED" : "OK",
  policyVersion: 1,
  requestId: `request_${id}`,
  resultCount: decision === "allowed" ? 2 : null,
  providerResultClass: decision === "allowed" ? "success" : null,
});

test("real accounts are mapped even when only Microsoft is configured", () => {
  const accounts = mapPublicAccounts([
    {
      id: "outlook_1",
      provider: "microsoft",
      address: "owner@outlook.com",
      paused: false,
      health: "healthy",
      scopes: ["Mail.Read", "Mail.ReadWrite", "Mail.Send"],
    },
  ]);

  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].provider, "outlook");
  assert.equal(accounts[0].label, "owner");
  assert.equal(accounts[0].permissions.drafts, true);
  assert.equal(accounts[0].permissions.send, true);
});

test("compose and approved-send capability reflects provider scopes", () => {
  const [readOnly, compose] = mapPublicAccounts([
    {
      id: "gmail_read",
      provider: "gmail",
      address: "read@gmail.com",
      paused: false,
      health: "healthy",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    },
    {
      id: "gmail_compose",
      provider: "gmail",
      address: "compose@gmail.com",
      paused: false,
      health: "healthy",
      scopes: ["https://www.googleapis.com/auth/gmail.compose"],
    },
  ]);

  assert.equal(readOnly.permissions.drafts, false);
  assert.equal(readOnly.permissions.send, false);
  assert.equal(compose.permissions.drafts, true);
  assert.equal(compose.permissions.send, true);
});

test("audit filters and presentation use actual event data", () => {
  const events = [event("allowed"), event("blocked"), event("changed")];
  assert.deepEqual(filterAuditEvents(events, "blocked").map(({ id }) => id), ["blocked"]);

  const presented = presentAuditEvent(events[0], "Work", "ChatGPT");
  assert.equal(presented.title, "Mail search completed");
  assert.match(presented.text, /allowed/i);
  assert.deepEqual(presented.tags, [
    "mail.search",
    "inbox:Work",
    "client:ChatGPT",
    "2 results",
    "provider:success",
  ]);
});

test("audit export contains the loaded append-only events", () => {
  const serialized = serializeAuditEvents([event("allowed")]);
  const payload = JSON.parse(serialized) as { exportedAt: string; events: AuditEvent[] };
  assert.equal(payload.events[0].id, "allowed");
  assert.match(payload.exportedAt, /^\d{4}-\d{2}-\d{2}T/);
});
