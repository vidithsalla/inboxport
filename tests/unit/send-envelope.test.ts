import assert from "node:assert/strict";
import test from "node:test";
import {
  assertEnvelopeExpiry,
  canonicalizeSendPayload,
  hashCanonicalSendPayload,
  transitionSendState,
} from "../../lib/relay/send-envelope.ts";

const input = {
  accountId: "account_personal",
  from: "me@example.com",
  to: ["person@example.net"],
  cc: [],
  bcc: [],
  subject: "Re: Contract",
  bodyText: "Hello\r\nWorld",
  bodyHtml: "<p>Hello\r\nWorld</p>",
  inReplyTo: "message_1",
  threadId: "thread_1",
};

test("canonicalization is deterministic across line endings", async () => {
  const first = canonicalizeSendPayload(input);
  const second = canonicalizeSendPayload({
    ...input,
    bodyText: "Hello\nWorld",
    bodyHtml: "<p>Hello\nWorld</p>",
  });

  assert.deepEqual(first, second);
  assert.equal(await hashCanonicalSendPayload(first), await hashCanonicalSendPayload(second));
});

test("changing only the HTML alternative changes the hash", async () => {
  const original = canonicalizeSendPayload(input);
  const htmlChanged = canonicalizeSendPayload({
    ...input,
    bodyHtml: "<p>Hello <b>World</b> — and a hidden line</p>",
  });

  assert.notEqual(
    await hashCanonicalSendPayload(original),
    await hashCanonicalSendPayload(htmlChanged),
  );
});

test("changing only the From header changes the hash", async () => {
  const original = canonicalizeSendPayload(input);
  const fromChanged = canonicalizeSendPayload({ ...input, from: "alias@example.com" });

  assert.notEqual(
    await hashCanonicalSendPayload(original),
    await hashCanonicalSendPayload(fromChanged),
  );
});

test("attachments are explicitly outside the first send release", () => {
  assert.throws(
    () => canonicalizeSendPayload({ ...input, attachments: [{ name: "invoice.pdf" }] }),
    /ATTACHMENTS_NOT_SUPPORTED_IN_MVP/,
  );
});

test("send state cannot skip approval or retry an unknown delivery", () => {
  assert.throws(() => transitionSendState("proposed", "dispatching"), /SEND_TRANSITION_FORBIDDEN/);
  assert.equal(transitionSendState("awaiting_approval", "approved"), "approved");
  assert.equal(transitionSendState("dispatching", "delivery_unknown"), "delivery_unknown");
  assert.throws(() => transitionSendState("delivery_unknown", "dispatching"), /SEND_TRANSITION_FORBIDDEN/);
});

test("approval envelopes expire within ten minutes", () => {
  const created = new Date("2026-07-21T12:00:00.000Z");
  assert.doesNotThrow(() =>
    assertEnvelopeExpiry(created, new Date("2026-07-21T12:10:00.000Z")),
  );
  assert.throws(
    () => assertEnvelopeExpiry(created, new Date("2026-07-21T12:10:00.001Z")),
    /SEND_ENVELOPE_TTL_INVALID/,
  );
});
