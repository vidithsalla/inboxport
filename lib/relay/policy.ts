import {
  permissionForOperation,
  type AuthorizationContext,
  type AuthorizationRequest,
  type PolicySnapshot,
} from "./contracts.ts";

export const POLICY_DENIAL_CODES = [
  "IDENTITY_MISMATCH",
  "GLOBAL_PAUSE",
  "ACCOUNT_NOT_GRANTED",
  "ACCOUNT_PAUSED",
  "PERMISSION_DENIED",
  "STALE_AUTHORIZATION",
] as const;

export type PolicyDenialCode = (typeof POLICY_DENIAL_CODES)[number];

export type AuthorizationDecision =
  | Readonly<{ allowed: true; context: AuthorizationContext }>
  | Readonly<{ allowed: false; code: PolicyDenialCode }>;

/**
 * Pure policy decision point. This function never calls a provider and never
 * accepts a provider credential. The resulting context is the only authority
 * that adapter methods accept inside the modular monolith.
 */
export function authorize(
  request: AuthorizationRequest,
  snapshot: PolicySnapshot,
  now = new Date(),
): AuthorizationDecision {
  const { identity } = request;

  if (
    identity.tenantId !== snapshot.tenantId ||
    identity.userId !== snapshot.userId ||
    identity.installationId !== snapshot.installationId
  ) {
    return { allowed: false, code: "IDENTITY_MISMATCH" };
  }

  if (snapshot.globallyPaused) {
    return { allowed: false, code: "GLOBAL_PAUSE" };
  }

  if (
    request.observedRevocationEpoch !== undefined &&
    request.observedRevocationEpoch !== snapshot.revocationEpoch
  ) {
    return { allowed: false, code: "STALE_AUTHORIZATION" };
  }

  const account = snapshot.accounts.find(
    (candidate) => candidate.accountId === request.accountId,
  );
  if (!account) {
    return { allowed: false, code: "ACCOUNT_NOT_GRANTED" };
  }

  if (account.paused) {
    return { allowed: false, code: "ACCOUNT_PAUSED" };
  }

  const requiredPermission = permissionForOperation(request.operation);
  if (!account.permissions[requiredPermission]) {
    return { allowed: false, code: "PERMISSION_DENIED" };
  }

  return {
    allowed: true,
    context: {
      ...identity,
      accountId: request.accountId,
      operation: request.operation,
      policyVersion: snapshot.policyVersion,
      revocationEpoch: snapshot.revocationEpoch,
      constraints: account.constraints,
      issuedAt: now.toISOString(),
    },
  };
}

export function authorizeEveryAccount(
  requests: readonly AuthorizationRequest[],
  snapshot: PolicySnapshot,
  now = new Date(),
): readonly AuthorizationDecision[] {
  return requests.map((request) => authorize(request, snapshot, now));
}
