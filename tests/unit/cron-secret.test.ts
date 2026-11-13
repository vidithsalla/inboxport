import assert from "node:assert/strict";
import test from "node:test";
import { isValidCronSecret } from "../../lib/relay/cron-auth.ts";

test("accepts the exact configured secret", () => {
  assert.equal(isValidCronSecret("Bearer correct-secret", "correct-secret"), true);
});

test("rejects a wrong secret of the same length", () => {
  assert.equal(isValidCronSecret("Bearer wrong-secreto", "correct-secret"), false);
});

test("rejects a wrong secret of a different length", () => {
  assert.equal(isValidCronSecret("Bearer short", "correct-secret"), false);
});

test("rejects a missing authorization header", () => {
  assert.equal(isValidCronSecret(null, "correct-secret"), false);
});
