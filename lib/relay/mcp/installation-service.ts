import { assertAuditEventSafe } from "../audit.ts";
import { MAIL_PERMISSIONS, type MailPermission } from "../contracts.ts";
import type { RelayRepository, StoredAccountGrant, StoredAuditEvent, StoredInstallation } from "../repository.ts";
import { MCP_TENANT_ID, hasComposeScope } from "./mail-tools-service.ts";

const POLICY_VERSION = 1;
/** `send` grants only the right to request approval; dispatch still requires a separate human approval per send (Phase 5). */
const GRANTABLE_PERMISSIONS: readonly MailPermission[] = ["search", "read_body", "draft", "send"];
const DEFAULT_CONSTRAINTS = { deniedLabelIds: [], maxResults: 50, maxBytes: 500_000 } as const;

function buildAuditEvent(
  userId: string,
  installationId: string,
  accountId: string | null,
  operation: StoredAuditEvent["operation"],
  decision: StoredAuditEvent["decision"],
  reasonCode: StoredAuditEvent["reasonCode"],
  requestId: string,
): StoredAuditEvent {
  const event: StoredAuditEvent = {
    id: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    userId,
    installationId,
    accountId,
    operation,
    decision,
    reasonCode,
    policyVersion: POLICY_VERSION,
    requestId,
    resultCount: null,
    providerResultClass: null,
  };
  assertAuditEventSafe({
    eventId: event.id,
    occurredAt: event.occurredAt,
    tenantId: MCP_TENANT_ID,
    userId: event.userId,
    installationId: event.installationId,
    ...(event.accountId ? { accountId: event.accountId } : {}),
    operation: event.operation,
    decision: event.decision,
    reasonCode: event.reasonCode,
    policyVersion: event.policyVersion,
    requestId: event.requestId,
  });
  return event;
}

export class InstallationManagementError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

/**
 * Called on every authenticated MCP request. Auto-provisions a visible
 * installation record on first contact from a new OAuth client, with zero
 * account grants: the user must explicitly grant accounts from the console
 * before any tool call against them will succeed.
 */
export async function recordInstallationContact(
  repository: RelayRepository,
  userId: string,
  clientId: string,
  clientName: string | null,
  requestId: string,
): Promise<StoredInstallation> {
  const { installation, created } = await repository.getOrCreateInstallation(
    userId,
    clientId,
    clientName,
  );
  if (created) {
    await repository.appendAudit(
      buildAuditEvent(
        userId,
        installation.id,
        null,
        "installation.connect",
        "changed",
        "OK",
        requestId,
      ),
    );
  } else {
    await repository.touchInstallation(installation.id);
  }
  return installation;
}

export type InstallationSummary = Readonly<{
  id: string;
  clientName: string | null;
  revoked: boolean;
  createdAt: string;
  lastSeenAt: string | null;
  grants: readonly Readonly<{
    accountId: string;
    permissions: Readonly<Record<string, boolean>>;
  }>[];
}>;

export async function listInstallationsForUser(
  repository: RelayRepository,
  userId: string,
): Promise<readonly InstallationSummary[]> {
  const installations = await repository.listInstallations(userId);
  return Promise.all(
    installations.map(async (installation) => {
      const grants = await repository.listAccountGrants(installation.id);
      return {
        id: installation.id,
        clientName: installation.clientName,
        revoked: installation.revoked,
        createdAt: installation.createdAt,
        lastSeenAt: installation.lastSeenAt,
        grants: grants.map((grant) => ({
          accountId: grant.accountId,
          permissions: grant.permissions,
        })),
      };
    }),
  );
}

export async function setInstallationRevoked(
  repository: RelayRepository,
  userId: string,
  installationId: string,
  revoked: boolean,
  requestId: string,
): Promise<boolean> {
  const changed = await repository.setInstallationRevoked(userId, installationId, revoked);
  if (changed) {
    await repository.appendAudit(
      buildAuditEvent(
        userId,
        installationId,
        null,
        "installation.revoke",
        "changed",
        revoked ? "INSTALLATION_REVOKED" : "INSTALLATION_RESTORED",
        requestId,
      ),
    );
  }
  return changed;
}

export async function renameInstallation(
  repository: RelayRepository,
  userId: string,
  installationId: string,
  clientName: string,
  requestId: string,
): Promise<boolean> {
  const changed = await repository.setInstallationName(userId, installationId, clientName);
  if (changed) {
    await repository.appendAudit(
      buildAuditEvent(
        userId,
        installationId,
        null,
        "installation.rename",
        "changed",
        "INSTALLATION_RENAMED",
        requestId,
      ),
    );
  }
  return changed;
}

export async function removeInstallation(
  repository: RelayRepository,
  userId: string,
  installationId: string,
  requestId: string,
): Promise<boolean> {
  const installation = await repository.getInstallation(userId, installationId);
  if (!installation) return false;

  // Keep a revoked tombstone so the same OAuth client cannot silently
  // reprovision itself after removal. Clear every grant so removal is not a
  // reversible pause with dormant mailbox access waiting behind it.
  const changed = await repository.setInstallationRevoked(userId, installationId, true);
  if (!changed) return false;
  const grants = await repository.listAccountGrants(installationId);
  await Promise.all(
    grants.map((grant) => repository.revokeAccountGrant(installationId, grant.accountId)),
  );
  await repository.appendAudit(
    buildAuditEvent(
      userId,
      installationId,
      null,
      "installation.revoke",
      "changed",
      "INSTALLATION_REMOVED",
      requestId,
    ),
  );
  return true;
}

/** Grants a bounded, explicitly-named set of read permissions for one account. */
export async function grantAccountAccess(
  repository: RelayRepository,
  userId: string,
  installationId: string,
  accountId: string,
  requestedPermissions: readonly string[],
  requestId: string,
): Promise<StoredAccountGrant | null> {
  const installation = await repository.getInstallation(userId, installationId);
  if (!installation) throw new InstallationManagementError("INSTALLATION_NOT_FOUND", 404);

  const account = await repository.getAccount(userId, accountId);
  if (!account || account.state !== "connected") {
    throw new InstallationManagementError("ACCOUNT_NOT_FOUND", 404);
  }

  const disallowed = requestedPermissions.filter(
    (permission) => !GRANTABLE_PERMISSIONS.includes(permission as MailPermission),
  );
  if (disallowed.length > 0) {
    throw new InstallationManagementError("PERMISSION_NOT_YET_AVAILABLE", 400);
  }
  if (
    (requestedPermissions.includes("draft") || requestedPermissions.includes("send")) &&
    !hasComposeScope(account)
  ) {
    throw new InstallationManagementError("COMPOSE_SCOPE_NOT_GRANTED", 409);
  }

  const permissions = Object.fromEntries(
    MAIL_PERMISSIONS.map((permission) => [
      permission,
      requestedPermissions.includes(permission),
    ]),
  );

  // A grant with every permission false isn't really a grant: the console UI
  // already treats "no permissions checked" as "delete the grant" client-side
  // (setInstallationGrant in app/page.tsx switches to DELETE rather than
  // POSTing an empty permissions array). Enforce the same invariant
  // server-side so a direct API call can't leave a listable, all-false grant
  // row behind -- list_granted_accounts lists any grant row regardless of its
  // permissions, so an all-false row would still hand an AI client the
  // account's decrypted address even though every actual operation is denied.
  if (!Object.values(permissions).some(Boolean)) {
    await repository.revokeAccountGrant(installationId, accountId);
    await repository.appendAudit(
      buildAuditEvent(userId, installationId, accountId, "policy.update", "changed", "GRANT_REVOKED", requestId),
    );
    return null;
  }

  await repository.upsertAccountGrant(installationId, accountId, permissions, DEFAULT_CONSTRAINTS);
  await repository.appendAudit(
    buildAuditEvent(
      userId,
      installationId,
      accountId,
      "policy.update",
      "changed",
      "GRANT_UPDATED",
      requestId,
    ),
  );
  const grant = await repository.getAccountGrant(installationId, accountId);
  if (!grant) throw new InstallationManagementError("GRANT_WRITE_FAILED", 500);
  return grant;
}

export async function revokeAccountAccess(
  repository: RelayRepository,
  userId: string,
  installationId: string,
  accountId: string,
  requestId: string,
): Promise<boolean> {
  const installation = await repository.getInstallation(userId, installationId);
  if (!installation) throw new InstallationManagementError("INSTALLATION_NOT_FOUND", 404);

  const removed = await repository.revokeAccountGrant(installationId, accountId);
  if (removed) {
    await repository.appendAudit(
      buildAuditEvent(
        userId,
        installationId,
        accountId,
        "policy.update",
        "changed",
        "GRANT_REVOKED",
        requestId,
      ),
    );
  }
  return removed;
}
