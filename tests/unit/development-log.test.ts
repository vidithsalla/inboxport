import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeDevelopmentLog } from "../../build/sanitize-development-log.ts";

test("development logs redact Gmail search parameters", () => {
  const message =
    "GET /api/mail/search?account_id=account-1&q=private%20query&max_results=20 200";

  const sanitized = sanitizeDevelopmentLog(message);

  assert.equal(
    sanitized,
    "GET /api/mail/search?[REDACTED] 200",
  );
  assert.doesNotMatch(sanitized, /private|account-1|max_results/);
});

test("development logs redact OAuth callback parameters", () => {
  const message =
    "GET /api/oauth/google/callback?state=private-state&code=private-code&scope=gmail.readonly 302";

  const sanitized = sanitizeDevelopmentLog(message);

  assert.equal(
    sanitized,
    "GET /api/oauth/google/callback?[REDACTED] 302",
  );
  assert.doesNotMatch(sanitized, /private-state|private-code|scope=/);
});

test("development logs redact Microsoft OAuth callback parameters", () => {
  const message =
    "GET /api/oauth/microsoft/callback?state=private-state&code=private-code 302";

  const sanitized = sanitizeDevelopmentLog(message);

  assert.equal(
    sanitized,
    "GET /api/oauth/microsoft/callback?[REDACTED] 302",
  );
  assert.doesNotMatch(sanitized, /private-state|private-code/);
});

test("development logs redact mail message and thread account identifiers", () => {
  const messageLine =
    "GET /api/mail/messages/msg-1?account_id=account-1 200";
  const threadLine =
    "GET /api/mail/threads/thread-1?account_id=account-1 200";

  assert.equal(
    sanitizeDevelopmentLog(messageLine),
    "GET /api/mail/messages/msg-1?[REDACTED] 200",
  );
  assert.equal(
    sanitizeDevelopmentLog(threadLine),
    "GET /api/mail/threads/thread-1?[REDACTED] 200",
  );
});

test("development logs preserve non-sensitive route messages", () => {
  const message = "GET /api/health 200";
  assert.equal(sanitizeDevelopmentLog(message), message);
});
