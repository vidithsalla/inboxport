import { timingSafeEqual } from "node:crypto";

/** Constant-time so a mistimed guess cannot compare the secret byte by byte. */
export function isValidCronSecret(authHeader: string | null, cronSecret: string): boolean {
  if (!authHeader) return false;
  const expected = Buffer.from(`Bearer ${cronSecret}`);
  const actual = Buffer.from(authHeader);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
