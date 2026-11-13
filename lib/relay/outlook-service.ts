import { addressContext as canonicalAddressContext, credentialContext as canonicalCredentialContext } from "./account-view.ts";
import { assertAuditEventSafe } from "./audit.ts";
import { MICROSOFT_MAIL_READ_SCOPE, type RuntimeConfig } from "./config.ts";
import {
  type EnvelopeVault,
  parseEnvelope,
  serializeEnvelope,
} from "./crypto.ts";
import {
  MicrosoftOAuthError,
  refreshMicrosoftAccessToken,
  type MicrosoftTokenSet,
} from "./microsoft-oauth.ts";
import { authorize } from "./policy.ts";
import { assertAdapterContext } from "./provider-adapter.ts";
import {
  OutlookApiError,
  OutlookAdapter,
  type OutlookProvider,
} from "./providers/outlook.ts";
import type { RelayRepository, StoredAuditEvent, StoredMailAccount } from "./repository.ts";
import type { RequestUser } from "./request-user.ts";

const INSTALLATION_ID = "relay-web-console";
const CLIENT_ID = "relay-web-console";
const POLICY_VERSION = 1;

export type PublicMailAccount = Readonly<{
  id: string;
  provider: "microsoft";
  address: string;
  paused: boolean;
  health: string;
  scopes: readonly string[];
  connectedAt: string;
}>;

// Delegates to account-view.ts's single canonical template so this file can
// never drift from the string every other reader/writer of these envelopes
// (mail-tools-service.ts, send-approval-service.ts) already uses.
const credentialContext = (userId: string, accountId: string) =>
  canonicalCredentialContext("microsoft", userId, accountId);
const addressContext = (userId: string, accountId: string) =>
  canonicalAddressContext("microsoft", userId, accountId);

function auditEvent(
  user: RequestUser,
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
    userId: user.id,
    installationId: INSTALLATION_ID,
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
    tenantId: "relay-personal",
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
 * Mirrors GmailReadOnlyService, deliberately not sharing its implementation:
 * Outlook's permission and revocation model genuinely differs from Gmail's
 * (Mail.Read/Mail.ReadWrite/Mail.Send are independent scopes, and Microsoft
 * has no simple token-revocation endpoint), so keeping this a separate,
 * explicit class avoids silently inheriting a Gmail-specific assumption.
 */
export class OutlookReadOnlyService {
  private readonly repository: RelayRepository;
  private readonly vault: EnvelopeVault;
  private readonly config: RuntimeConfig & {
    microsoftClientId: string;
    microsoftClientSecret: string;
  };
  private readonly adapter: OutlookProvider;
  private readonly fetcher: typeof fetch;

  constructor(
    repository: RelayRepository,
    vault: EnvelopeVault,
    config: RuntimeConfig & {
      microsoftClientId: string;
      microsoftClientSecret: string;
    },
    adapter: OutlookProvider = new OutlookAdapter(),
    fetcher: typeof fetch = fetch,
  ) {
    this.repository = repository;
    this.vault = vault;
    this.config = config;
    this.adapter = adapter;
    this.fetcher = fetcher;
  }

  async connect(
    user: RequestUser,
    tokens: MicrosoftTokenSet,
    requestId: string,
  ): Promise<PublicMailAccount> {
    if (!tokens.refreshToken) throw new MicrosoftOAuthError("MICROSOFT_REFRESH_TOKEN_MISSING", 400);
    if (!tokens.scopes.some((scope) => scope.toLowerCase() === MICROSOFT_MAIL_READ_SCOPE.toLowerCase())) {
      throw new MicrosoftOAuthError("MICROSOFT_REQUIRED_SCOPE_NOT_GRANTED", 403);
    }

    const profile = await this.adapter.getProfile(tokens.accessToken);
    const subjectHash = await this.vault.fingerprint(
      profile.emailAddress.toLowerCase(),
      "relay-mail:microsoft-subject:v1",
    );
    const existing = await this.repository.findAccountByProviderSubject(
      user.id,
      "microsoft",
      subjectHash,
    );
    const id = existing?.id ?? crypto.randomUUID();
    const now = new Date().toISOString();
    const credentialEnvelope = await this.vault.seal(
      tokens.refreshToken,
      credentialContext(user.id, id),
    );
    const encryptedAddress = await this.vault.seal(
      profile.emailAddress,
      addressContext(user.id, id),
    );
    const account: StoredMailAccount = {
      id,
      userId: user.id,
      provider: "microsoft",
      providerSubjectHash: subjectHash,
      encryptedAddress: serializeEnvelope(encryptedAddress),
      credentialEnvelope: serializeEnvelope(credentialEnvelope),
      scopes: tokens.scopes,
      paused: false,
      state: "connected",
      health: "healthy",
      historyId: null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      disconnectedAt: null,
    };
    await this.repository.upsertAccount(account);
    await this.repository.appendAudit(
      auditEvent(user, id, "account.connect", "changed", "OK", requestId, null, "success"),
    );
    return this.toPublicAccount(account);
  }

  async listAccounts(user: RequestUser): Promise<readonly PublicMailAccount[]> {
    const accounts = await this.repository.listAccounts(user.id);
    return Promise.all(
      accounts
        .filter((account) => account.provider === "microsoft")
        .map((account) => this.toPublicAccount(account)),
    );
  }

  async setPaused(
    user: RequestUser,
    accountId: string,
    paused: boolean,
    requestId: string,
  ): Promise<boolean> {
    const changed = await this.repository.setAccountPaused(user.id, accountId, paused);
    if (changed) {
      await this.repository.appendAudit(
        auditEvent(user, accountId, "policy.update", "changed", "POLICY_UPDATED", requestId),
      );
    }
    return changed;
  }

  /**
   * Unlike Gmail, there is no simple Microsoft REST endpoint to revoke a
   * single refresh token, so disconnecting always completes locally: the
   * stored credential is crypto-shredded and the account marked
   * `disconnected` immediately. There is no `revocation_pending` state for
   * Outlook accounts.
   */
  async disconnect(
    user: RequestUser,
    accountId: string,
    requestId: string,
  ): Promise<"disconnected" | "not_found"> {
    const account = await this.repository.getAccount(user.id, accountId);
    // Defense-in-depth: never let the Outlook service act on another
    // provider's account even if a caller dispatched here by mistake.
    if (!account || account.provider !== "microsoft") return "not_found";
    await this.repository.setAccountPaused(user.id, accountId, true);
    await this.repository.finishDisconnect(user.id, accountId, "disconnected");
    await this.repository.appendAudit(
      auditEvent(
        user,
        accountId,
        "account.disconnect",
        "changed",
        "ACCOUNT_DISCONNECTED",
        requestId,
        null,
        "success",
      ),
    );
    return "disconnected";
  }

  async search(user: RequestUser, accountId: string, query: string, maxResults: number, requestId: string) {
    return this.withAuthorizedAccount(
      user,
      accountId,
      "mail.search",
      requestId,
      async (accessToken, context) => {
        assertAdapterContext(context, accountId, "mail.search");
        const results = await this.adapter.search(accessToken, query, maxResults);
        await this.repository.appendAudit(
          auditEvent(user, accountId, "mail.search", "allowed", "OK", requestId, results.length, "success"),
        );
        return results;
      },
    );
  }

  async getMessage(user: RequestUser, accountId: string, messageId: string, requestId: string) {
    return this.withAuthorizedAccount(
      user,
      accountId,
      "mail.message.get",
      requestId,
      async (accessToken, context) => {
        assertAdapterContext(context, accountId, "mail.message.get");
        const message = await this.adapter.getMessage(
          accessToken,
          messageId,
          context.constraints.maxBytes,
        );
        await this.repository.appendAudit(
          auditEvent(user, accountId, "mail.message.get", "allowed", "OK", requestId, 1, "success"),
        );
        return message;
      },
    );
  }

  async getThread(user: RequestUser, accountId: string, threadId: string, requestId: string) {
    return this.withAuthorizedAccount(
      user,
      accountId,
      "mail.thread.get",
      requestId,
      async (accessToken, context) => {
        assertAdapterContext(context, accountId, "mail.thread.get");
        const thread = await this.adapter.getThread(
          accessToken,
          threadId,
          context.constraints.maxBytes,
        );
        await this.repository.appendAudit(
          auditEvent(
            user,
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

  private async withAuthorizedAccount<T>(
    user: RequestUser,
    accountId: string,
    operation: "mail.search" | "mail.message.get" | "mail.thread.get",
    requestId: string,
    execute: (
      accessToken: string,
      context: Extract<ReturnType<typeof authorize>, { allowed: true }>["context"],
    ) => Promise<T>,
  ): Promise<T> {
    const account = await this.repository.getAccount(user.id, accountId);
    const decision = authorize(
      {
        identity: {
          tenantId: "relay-personal",
          userId: user.id,
          installationId: INSTALLATION_ID,
          clientId: CLIENT_ID,
        },
        accountId,
        operation,
      },
      {
        tenantId: "relay-personal",
        userId: user.id,
        installationId: INSTALLATION_ID,
        policyVersion: POLICY_VERSION,
        revocationEpoch: 1,
        globallyPaused: false,
        accounts:
          account && account.provider === "microsoft" && account.state === "connected"
            ? [{
                accountId: account.id,
                paused: account.paused,
                permissions: { search: true, read_body: true, draft: false, send: false },
                constraints: { deniedLabelIds: [], maxResults: 50, maxBytes: 500_000 },
              }]
            : [],
      },
    );
    if (!decision.allowed) {
      await this.repository.appendAudit(
        auditEvent(user, accountId, operation, "blocked", decision.code, requestId, null, "denied"),
      );
      throw new OutlookAccessError(decision.code, 403);
    }
    if (!account?.credentialEnvelope) {
      throw new OutlookAccessError("ACCOUNT_CREDENTIAL_UNAVAILABLE", 409);
    }

    const rateLimit = await this.repository.consumeRateLimit(
      user.id,
      accountId,
      operation,
      operation === "mail.search" ? 30 : 60,
      60,
    );
    if (!rateLimit.allowed) {
      await this.repository.appendAudit(
        auditEvent(user, accountId, operation, "blocked", "RATE_LIMITED", requestId, null, "rate_limited"),
      );
      throw new OutlookAccessError("RATE_LIMITED", 429);
    }

    try {
      const refreshToken = await this.vault.open(
        parseEnvelope(account.credentialEnvelope),
        credentialContext(user.id, account.id),
      );
      const tokens = await refreshMicrosoftAccessToken(this.config, refreshToken, this.fetcher);
      // Microsoft rotates the refresh token on each refresh; the old one is
      // eventually invalidated. Persist the replacement so the account does
      // not silently drift into a forced re-authorization.
      if (tokens.refreshToken && tokens.refreshToken !== refreshToken) {
        const resealed = await this.vault.seal(
          tokens.refreshToken,
          credentialContext(user.id, account.id),
        );
        await this.repository.updateAccountCredential(
          user.id,
          account.id,
          serializeEnvelope(resealed),
        );
      }
      const result = await execute(tokens.accessToken, decision.context);
      // Health is an observation of the latest usable provider connection,
      // not a permanent record of an old Graph failure. A successful request
      // proves the account is usable again.
      if (account.health !== "healthy") {
        await this.repository.setAccountHealth(user.id, accountId, "healthy");
      }
      return result;
    } catch (error) {
      if (
        error instanceof MicrosoftOAuthError ||
        (error instanceof OutlookApiError && error.code === "UNAUTHORIZED")
      ) {
        await this.repository.setAccountHealth(user.id, accountId, "reauthorization_required");
      } else if (
        error instanceof OutlookApiError &&
        (error.code === "FORBIDDEN" || error.code === "INVALID_RESPONSE")
      ) {
        await this.repository.setAccountHealth(user.id, accountId, "provider_error");
      }
      throw error;
    }
  }

  private async toPublicAccount(account: StoredMailAccount): Promise<PublicMailAccount> {
    const address = await this.vault.open(
      parseEnvelope(account.encryptedAddress),
      addressContext(account.userId, account.id),
    );
    return {
      id: account.id,
      provider: "microsoft",
      address,
      paused: account.paused,
      health: account.health,
      scopes: account.scopes,
      connectedAt: account.createdAt,
    };
  }
}

export class OutlookAccessError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
