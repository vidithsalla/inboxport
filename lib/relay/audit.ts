import type { MailOperation } from "./contracts.ts";
import type { PolicyDenialCode } from "./policy.ts";

export type AuditDecision = "allowed" | "blocked" | "changed";

export type AuditEvent = Readonly<{
  eventId: string;
  occurredAt: string;
  tenantId: string;
  userId: string;
  installationId: string;
  accountId?: string;
  operation:
    | MailOperation
    | "policy.update"
    | "account.disconnect"
    | "installation.connect"
    | "installation.rename"
    | "installation.revoke"
    | "account.history_synced"
    | "account.watch_renewed";
  decision: AuditDecision;
  reasonCode:
    | PolicyDenialCode
    | "POLICY_UPDATED"
    | "ACCOUNT_DISCONNECTED"
    | "OK"
    | "GRANT_UPDATED"
    | "GRANT_REVOKED"
    | "INSTALLATION_RENAMED"
    | "INSTALLATION_REMOVED"
    | "INSTALLATION_REVOKED"
    | "INSTALLATION_RESTORED"
    | "FULL_RESYNC"
    | "REAUTHORIZATION_REQUIRED"
    | "PROVIDER_ERROR";
  policyVersion: number;
  requestId: string;
  resultCount?: number;
  providerResultClass?: "success" | "denied" | "rate_limited" | "failed" | "unknown";
}>;

const ALLOWED_AUDIT_KEYS = new Set([
  "eventId",
  "occurredAt",
  "tenantId",
  "userId",
  "installationId",
  "accountId",
  "operation",
  "decision",
  "reasonCode",
  "policyVersion",
  "requestId",
  "resultCount",
  "providerResultClass",
]);

const CONTENT_KEY_PATTERN =
  /query|subject|snippet|body|content|recipient|attachment|authorization|access.?token|refresh.?token|provider.?error|raw/i;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const TOKEN_PATTERN = /\b(?:ya29\.|rly_(?:live|demo)_|Bearer\s+)[^\s]+/i;

/** Runtime guard for boundaries where typed callers are not sufficient. */
export function assertAuditEventSafe(event: unknown): asserts event is AuditEvent {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new Error("AUDIT_EVENT_INVALID");
  }

  for (const [key, value] of Object.entries(event)) {
    if (!ALLOWED_AUDIT_KEYS.has(key) || CONTENT_KEY_PATTERN.test(key)) {
      throw new Error(`AUDIT_FIELD_FORBIDDEN:${key}`);
    }
    if (
      typeof value === "string" &&
      (value.length > 256 || EMAIL_PATTERN.test(value) || TOKEN_PATTERN.test(value))
    ) {
      throw new Error(`AUDIT_VALUE_FORBIDDEN:${key}`);
    }
  }
}

/**
 * Repository-boundary guard. Maps a stored audit row (which uses `id` and may
 * carry null optionals) onto the AuditEvent shape and runs assertAuditEventSafe,
 * so persistence enforces the content-free contract itself even if some future
 * caller forgets to. Defense-in-depth on top of the per-service guards.
 */
export function assertStoredAuditEventSafe(event: {
  id: string;
  occurredAt: string;
  tenantId?: string;
  userId: string;
  installationId: string;
  accountId?: string | null;
  operation: string;
  decision: string;
  reasonCode: string;
  policyVersion: number;
  requestId: string;
  resultCount?: number | null;
  providerResultClass?: string | null;
}): void {
  assertAuditEventSafe({
    eventId: event.id,
    occurredAt: event.occurredAt,
    ...(event.tenantId ? { tenantId: event.tenantId } : {}),
    userId: event.userId,
    installationId: event.installationId,
    ...(event.accountId ? { accountId: event.accountId } : {}),
    operation: event.operation,
    decision: event.decision,
    reasonCode: event.reasonCode,
    policyVersion: event.policyVersion,
    requestId: event.requestId,
    ...(event.resultCount == null ? {} : { resultCount: event.resultCount }),
    ...(event.providerResultClass == null
      ? {}
      : { providerResultClass: event.providerResultClass }),
  });
}

const TELEMETRY_SECRET_KEY_PATTERN =
  /authorization|cookie|token|secret|password|credential|query|subject|snippet|body|content|recipient|attachment|mime|raw/i;

export function redactTelemetry(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactTelemetry);
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && (EMAIL_PATTERN.test(value) || TOKEN_PATTERN.test(value))) {
      return "[REDACTED]";
    }
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      TELEMETRY_SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : redactTelemetry(nested),
    ]),
  );
}
