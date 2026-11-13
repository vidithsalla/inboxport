import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { noHeaderInjection } from "../../lib/relay/provider-adapter.ts";

/**
 * Codex audit finding: Gmail's draft builder interpolates to/cc/bcc/subject/
 * in_reply_to directly into raw MIME header lines. A bare CR or LF in any of
 * these is a header terminator in RFC 5322 -- unvalidated, it would let a
 * caller inject an additional header (e.g. a hidden Bcc) that never appears
 * in the fields the approval preview actually reviews. This is enforced at
 * the MCP tool schema boundary, before any MIME or Graph JSON is built.
 */
test("noHeaderInjection rejects a value containing a bare CR or LF", () => {
  const schema = noHeaderInjection(z.string());
  assert.equal(schema.safeParse("ordinary subject").success, true);
  assert.equal(schema.safeParse("Hello\r\nBcc: attacker@example.com").success, false);
  assert.equal(schema.safeParse("Hello\nBcc: attacker@example.com").success, false);
  assert.equal(schema.safeParse("Hello\rBcc: attacker@example.com").success, false);
});

test("noHeaderInjection composes with existing string constraints", () => {
  const schema = noHeaderInjection(z.string().max(5));
  assert.equal(schema.safeParse("short").success, true);
  assert.equal(schema.safeParse("way too long").success, false);
  assert.equal(schema.safeParse("a\nb").success, false);
});
