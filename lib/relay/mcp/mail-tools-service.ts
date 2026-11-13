import { assertAuditEventSafe } from "../audit.ts";
import { addressContext, credentialContext } from "../account-view.ts";
import {
  GMAIL_COMPOSE_SCOPE,
  MICROSOFT_MAIL_READWRITE_SCOPE,
  MICROSOFT_MAIL_SEND_SCOPE,
  type VaultReadyConfig,
} from "../config.ts";
import { type EnvelopeVault, parseEnvelope, serializeEnvelope } from "../crypto.ts";
import {
  MAIL_PERMISSIONS,
  type AuthorizationContext,
  type MailOperation,
  type MailPermission,
  type PolicySnapshot,
} from "../contracts.ts";
import { GoogleOAuthError, refreshGoogleAccessToken } from "../google-oauth.ts";
import { MicrosoftOAuthError, refreshMicrosoftAccessToken } from "../microsoft-oauth.ts";
import { authorize } from "../policy.ts";
import {
  assertAdapterContext,
  type MailDraftResult,
  type MailMessage,
  type MailSearchResult,
  type MailThread,
  type ProviderDraftInput,
} from "../provider-adapter.ts";
import {
  GmailApiError,
  type GmailProvider,
} from "../providers/gmail.ts";
import { OutlookApiError, type OutlookProvider } from "../providers/outlook.ts";
import type { RelayRepository, StoredAuditEvent, StoredMailAccount } from "../repository.ts";

export const MCP_TENANT_ID = "relay-personal";
const POLICY_VERSION = 1;
const MAX_ACCOUNTS_PER_MULTI_READ = 5;

export type SingleAccountOperation = Extract<
  MailOperation,
  | "mail.search"
  | "mail.message.get"
  | "mail.thread.get"
  | "mail.draft.create"
  | "mail.draft.update"
  | "mail.send.request_approval"
  | "mail.send.dispatch"
>;

export class McpMailAccessError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const normalizePermissions = (
  raw: Readonly<Record<string, boolean>>,
): Record<MailPermission, boolean> =>
  Object.fromEntries(
    MAIL_PERMISSIONS.map((permission) => [permission, raw[permission] === true]),
  ) as Record<MailPermission, boolean>;

export function buildAuditEvent(
  userId: string,
  installationId: string,
  accountId: string | null,
  operation: StoredAuditEvent["operation"],
  decision: StoredAuditEvent["decision"],
  reasonCode: StoredAuditEvent["reasonCode"],
  requestId: string,
  resultCount: number | null = null,
  providerResultClass: string | null = null,
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
    resultCount,
    providerResultClass,
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
    ...(event.resultCount === null ? {} : { resultCount: event.resultCount }),
    ...(event.providerResultClass === null
      ? {}
      : { providerResultClass: event.providerResultClass }),
  });
  return event;
}

/**
 * `config` only guarantees the vault key: MCP's data plane (repository +
 * vault) is provider-neutral, and this is shared by every route that touches
 * installations/grants/approvals/audit, not only Gmail-scoped ones. Neither
 * provider's OAuth client credentials are required up front -- each is
 * checked lazily, only when an operation actually needs to refresh that
 * specific provider's token (see refreshAccessToken below), the same way
 * Outlook's MICROSOFT_NOT_CONFIGURED already worked before this file needed
 * a symmetric GOOGLE_NOT_CONFIGURED check.
 */
export type McpToolDependencies = Readonly<{
  repository: RelayRepository;
  vault: EnvelopeVault;
  config: VaultReadyConfig;
  adapters: Readonly<{ gmail: GmailProvider; outlook: OutlookProvider }>;
  fetcher?: typeof fetch;
}>;

export async function buildSnapshotForAccount(
  deps: McpToolDependencies,
  userId: string,
  installationId: string,
  accountId: string,
): Promise<PolicySnapshot> {
  const installation = await deps.repository.getInstallation(userId, installationId);
  const [account, grant] = await Promise.all([
    deps.repository.getAccount(userId, accountId),
    deps.repository.getAccountGrant(installationId, accountId),
  ]);

  const accounts =
    account &&
    grant &&
    account.state === "connected" &&
    (account.provider === "gmail" || account.provider === "microsoft")
      ? [
          {
            accountId: account.id,
            paused: account.paused,
            permissions: normalizePermissions(grant.permissions),
            constraints: grant.constraints,
          },
        ]
      : [];

  return {
    tenantId: MCP_TENANT_ID,
    userId,
    installationId,
    policyVersion: POLICY_VERSION,
    revocationEpoch: installation?.revocationEpoch ?? 0,
    globallyPaused: !installation || installation.revoked,
    accounts,
  };
}

/**
 * Refreshes a just-in-time access token for whichever provider owns this
 * account. Microsoft rotates the refresh token on every use (Google does
 * not), so a rotated token is returned for the caller to persist -- mirrors
 * OutlookReadOnlyService's own rotation handling, which this path does not
 * go through.
 */
async function refreshAccessToken(
  deps: McpToolDependencies,
  account: StoredMailAccount,
  refreshToken: string,
): Promise<Readonly<{ accessToken: string; rotatedRefreshToken: string | null }>> {
  if (account.provider === "microsoft") {
    const { microsoftClientId, microsoftClientSecret } = deps.config;
    if (!microsoftClientId || !microsoftClientSecret) {
      throw new McpMailAccessError("MICROSOFT_NOT_CONFIGURED", 503);
    }
    const tokens = await refreshMicrosoftAccessToken(
      { ...deps.config, microsoftClientId, microsoftClientSecret },
      refreshToken,
      deps.fetcher ?? fetch,
    );
    return {
      accessToken: tokens.accessToken,
      rotatedRefreshToken:
        tokens.refreshToken && tokens.refreshToken !== refreshToken ? tokens.refreshToken : null,
    };
  }
  const { googleClientId, googleClientSecret } = deps.config;
  if (!googleClientId || !googleClientSecret) {
    throw new McpMailAccessError("GOOGLE_NOT_CONFIGURED", 503);
  }
  const tokens = await refreshGoogleAccessToken(
    { ...deps.config, googleClientId, googleClientSecret },
    refreshToken,
    deps.fetcher ?? fetch,
  );
  return { accessToken: tokens.accessToken, rotatedRefreshToken: null };
}

/**
 * Authorizes exactly one explicit account for one installation, refreshes a
 * just-in-time access token for whichever provider owns the account, executes
 * the provider call, and writes a content-free audit event. Mirrors each
 * provider's own *ReadOnlyService.withAuthorizedAccount but keyed by a real
 * per-installation grant instead of the console's fixed single-installation
 * identity.
 */
export async function withAuthorizedAccount<T>(
  deps: McpToolDependencies,
  userId: string,
  installationId: string,
  clientId: string,
  accountId: string,
  operation: SingleAccountOperation,
  requestId: string,
  execute: (
    accessToken: string,
    context: AuthorizationContext,
    account: StoredMailAccount,
    permissions: Record<MailPermission, boolean>,
  ) => Promise<T>,
): Promise<T> {
  const snapshot = await buildSnapshotForAccount(deps, userId, installationId, accountId);
  const decision = authorize(
    {
      identity: { tenantId: MCP_TENANT_ID, userId, installationId, clientId },
      accountId,
      operation,
    },
    snapshot,
  );

  if (!decision.allowed) {
    await deps.repository.appendAudit(
      buildAuditEvent(
        userId,
        installationId,
        accountId,
        operation,
        "blocked",
        decision.code,
        requestId,
        null,
        "denied",
      ),
    );
    throw new McpMailAccessError(decision.code, 403);
  }

  const account = await deps.repository.getAccount(userId, accountId);
  if (!account?.credentialEnvelope) {
    throw new McpMailAccessError("ACCOUNT_CREDENTIAL_UNAVAILABLE", 409);
  }

  const rateLimit = await deps.repository.consumeRateLimit(
    userId,
    accountId,
    operation,
    operation === "mail.search" ? 30 : 60,
    60,
  );
  if (!rateLimit.allowed) {
    await deps.repository.appendAudit(
      buildAuditEvent(
        userId,
        installationId,
        accountId,
        operation,
        "blocked",
        "RATE_LIMITED",
        requestId,
        null,
        "rate_limited",
      ),
    );
    throw new McpMailAccessError("RATE_LIMITED", 429);
  }

  try {
    const refreshToken = await deps.vault.open(
      parseEnvelope(account.credentialEnvelope),
      credentialContext(account.provider, userId, account.id),
    );
    const { accessToken, rotatedRefreshToken } = await refreshAccessToken(
      deps,
      account,
      refreshToken,
    );
    if (rotatedRefreshToken) {
      const resealed = await deps.vault.seal(
        rotatedRefreshToken,
        credentialContext(account.provider, userId, account.id),
      );
      await deps.repository.updateAccountCredential(userId, account.id, serializeEnvelope(resealed));
    }
    assertAdapterContext(decision.context, accountId, operation);
    const grantedPermissions =
      snapshot.accounts.find((entry) => entry.accountId === accountId)?.permissions ??
      normalizePermissions({});
    const result = await execute(accessToken, decision.context, account, grantedPermissions);
    if (account.health !== "healthy") {
      await deps.repository.setAccountHealth(userId, accountId, "healthy");
    }
    return result;
  } catch (error) {
    if (
      error instanceof GoogleOAuthError ||
      error instanceof MicrosoftOAuthError ||
      (error instanceof GmailApiError && error.code === "UNAUTHORIZED") ||
      (error instanceof OutlookApiError && error.code === "UNAUTHORIZED")
    ) {
      await deps.repository.setAccountHealth(userId, accountId, "reauthorization_required");
    } else if (
      (error instanceof GmailApiError || error instanceof OutlookApiError) &&
      (error.code === "FORBIDDEN" || error.code === "INVALID_RESPONSE")
    ) {
      await deps.repository.setAccountHealth(userId, accountId, "provider_error");
    }
    throw error;
  }
}

export async function mcpSearch(
  deps: McpToolDependencies,
  userId: string,
  installationId: string,
  clientId: string,
  accountId: string,
  query: string,
  maxResults: number,
  requestId: string,
): Promise<readonly MailSearchResult[]> {
  return withAuthorizedAccount(
    deps,
    userId,
    installationId,
    clientId,
    accountId,
    "mail.search",
    requestId,
    async (accessToken, context, account, permissions) => {
      const adapter = account.provider === "microsoft" ? deps.adapters.outlook : deps.adapters.gmail;
      const results = await adapter.search(
        accessToken,
        query,
        Math.min(maxResults, context.constraints.maxResults),
      );
      // A snippet is a body-derived preview, so a search-only grant must not
      // leak it: search returns pure metadata unless read_body is also granted.
      // This keeps disclosure monotonic with permissions and honors the
      // console's "search = metadata only" contract, for every provider.
      const visible = permissions.read_body
        ? results
        : results.map((result) => ({ ...result, snippet: "" }));
      await deps.repository.appendAudit(
        buildAuditEvent(
          userId,
          installationId,
          accountId,
          "mail.search",
          "allowed",
          "OK",
          requestId,
          visible.length,
          "success",
        ),
      );
      return visible;
    },
  );
}

export async function mcpGetMessage(
  deps: McpToolDependencies,
  userId: string,
  installationId: string,
  clientId: string,
  accountId: string,
  messageId: string,
  requestId: string,
): Promise<MailMessage> {
  return withAuthorizedAccount(
    deps,
    userId,
    installationId,
    clientId,
    accountId,
    "mail.message.get",
    requestId,
    async (accessToken, context, account) => {
      const adapter = account.provider === "microsoft" ? deps.adapters.outlook : deps.adapters.gmail;
      const message = await adapter.getMessage(
        accessToken,
        messageId,
        context.constraints.maxBytes,
      );
      await deps.repository.appendAudit(
        buildAuditEvent(
          userId,
          installationId,
          accountId,
          "mail.message.get",
          "allowed",
          "OK",
          requestId,
          1,
          "success",
        ),
      );
      return message;
    },
  );
}

export async function mcpGetThread(
  deps: McpToolDependencies,
  userId: string,
  installationId: string,
  clientId: string,
  accountId: string,
  threadId: string,
  requestId: string,
): Promise<MailThread> {
  return withAuthorizedAccount(
    deps,
    userId,
    installationId,
    clientId,
    accountId,
    "mail.thread.get",
    requestId,
    async (accessToken, context, account) => {
      const adapter = account.provider === "microsoft" ? deps.adapters.outlook : deps.adapters.gmail;
      const thread = await adapter.getThread(accessToken, threadId, context.constraints.maxBytes);
      await deps.repository.appendAudit(
        buildAuditEvent(
          userId,
          installationId,
          accountId,
          "mail.thread.get",
          "allowed",
          "OK",
          requestId,
          thread.messages.length,
          "success",
        ),
      );
      return thread;
    },
  );
}

/**
 * Gmail's single GMAIL_COMPOSE_SCOPE covers both draft and send; Graph
 * splits that into two independent delegated permissions, so an Outlook
 * account needs both Mail.ReadWrite and Mail.Send present. Exported so both
 * grant-time validation (installation-service.ts) and dispatch-time
 * validation (assertComposeScope below) check the exact same condition --
 * they must never be allowed to drift apart.
 */
export function hasComposeScope(account: StoredMailAccount): boolean {
  return account.provider === "microsoft"
    ? account.scopes.includes(MICROSOFT_MAIL_READWRITE_SCOPE) &&
        account.scopes.includes(MICROSOFT_MAIL_SEND_SCOPE)
    : account.scopes.includes(GMAIL_COMPOSE_SCOPE);
}

/** Rejects a draft/send operation if the underlying provider credential lacks compose scope. */
export function assertComposeScope(account: StoredMailAccount): void {
  if (!hasComposeScope(account)) {
    throw new McpMailAccessError("COMPOSE_SCOPE_NOT_GRANTED", 403);
  }
}

export async function mcpCreateDraft(
  deps: McpToolDependencies,
  userId: string,
  installationId: string,
  clientId: string,
  accountId: string,
  draft: ProviderDraftInput,
  requestId: string,
): Promise<MailDraftResult> {
  return withAuthorizedAccount(
    deps,
    userId,
    installationId,
    clientId,
    accountId,
    "mail.draft.create",
    requestId,
    async (accessToken, _context, account) => {
      assertComposeScope(account);
      const adapter = account.provider === "microsoft" ? deps.adapters.outlook : deps.adapters.gmail;
      const result = await adapter.createDraft(accessToken, draft);
      await deps.repository.appendAudit(
        buildAuditEvent(
          userId,
          installationId,
          accountId,
          "mail.draft.create",
          "allowed",
          "OK",
          requestId,
          1,
          "success",
        ),
      );
      return result;
    },
  );
}

export async function mcpUpdateDraft(
  deps: McpToolDependencies,
  userId: string,
  installationId: string,
  clientId: string,
  accountId: string,
  providerDraftId: string,
  draft: ProviderDraftInput,
  requestId: string,
): Promise<MailDraftResult> {
  return withAuthorizedAccount(
    deps,
    userId,
    installationId,
    clientId,
    accountId,
    "mail.draft.update",
    requestId,
    async (accessToken, _context, account) => {
      assertComposeScope(account);
      const adapter = account.provider === "microsoft" ? deps.adapters.outlook : deps.adapters.gmail;
      const result = await adapter.updateDraft(accessToken, providerDraftId, draft);
      await deps.repository.appendAudit(
        buildAuditEvent(
          userId,
          installationId,
          accountId,
          "mail.draft.update",
          "allowed",
          "OK",
          requestId,
          1,
          "success",
        ),
      );
      return result;
    },
  );
}

export type MultiAccountSearchResult = Readonly<{
  accountId: string;
  ok: boolean;
  results: readonly MailSearchResult[];
  errorCode: string | null;
}>;

/**
 * Bounded multi-account read: each named account is authorized and executed
 * independently, so one denied or failed account never blocks the others and
 * never leaks why a sibling account was denied.
 */
export async function mcpSearchMany(
  deps: McpToolDependencies,
  userId: string,
  installationId: string,
  clientId: string,
  accountIds: readonly string[],
  query: string,
  maxResults: number,
  requestId: string,
): Promise<readonly MultiAccountSearchResult[]> {
  if (accountIds.length === 0) {
    throw new McpMailAccessError("ACCOUNT_ID_REQUIRED", 400);
  }
  if (accountIds.length > MAX_ACCOUNTS_PER_MULTI_READ) {
    throw new McpMailAccessError("TOO_MANY_ACCOUNTS", 400);
  }

  const uniqueAccountIds = [...new Set(accountIds)];
  return Promise.all(
    uniqueAccountIds.map(async (accountId): Promise<MultiAccountSearchResult> => {
      try {
        const results = await mcpSearch(
          deps,
          userId,
          installationId,
          clientId,
          accountId,
          query,
          maxResults,
          requestId,
        );
        return { accountId, ok: true, results, errorCode: null };
      } catch (error) {
        const errorCode =
          error instanceof McpMailAccessError ||
          error instanceof GmailApiError ||
          error instanceof OutlookApiError
            ? error.message
            : "RELAY_INTERNAL_ERROR";
        return { accountId, ok: false, results: [], errorCode };
      }
    }),
  );
}

export type GrantedAccountSummary = Readonly<{
  accountId: string;
  address: string;
  permissions: Readonly<Record<MailPermission, boolean>>;
  paused: boolean;
}>;

/** Lists only the accounts this specific installation has been explicitly granted. */
export async function mcpListGrantedAccounts(
  deps: McpToolDependencies,
  userId: string,
  installationId: string,
): Promise<readonly GrantedAccountSummary[]> {
  const grants = await deps.repository.listAccountGrants(installationId);
  const summaries = await Promise.all(
    grants.map(async (grant) => {
      const permissions = normalizePermissions(grant.permissions);
      // Defense in depth: a grant row with every permission false grants
      // nothing and should behave as if it doesn't exist. grantAccountAccess
      // now revokes rather than persisting such a row, but this also covers
      // any row written by another path before that guard existed. Checked
      // before decrypting the address so a permission-less grant never
      // causes the account's address to be decrypted at all.
      if (!Object.values(permissions).some(Boolean)) return null;
      const account = await deps.repository.getAccount(userId, grant.accountId);
      if (!account || account.state !== "connected") return null;
      const address = await deps.vault.open(
        parseEnvelope(account.encryptedAddress),
        addressContext(account.provider, userId, account.id),
      );
      return {
        accountId: account.id,
        address,
        permissions,
        paused: account.paused,
      } satisfies GrantedAccountSummary;
    }),
  );
  return summaries.filter((summary): summary is GrantedAccountSummary => summary !== null);
}
