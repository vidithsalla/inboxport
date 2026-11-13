import { OAuth2Client } from "google-auth-library";
import { credentialContext } from "./account-view.ts";
import { assertAuditEventSafe } from "./audit.ts";
import type { RuntimeConfig } from "./config.ts";
import { type EnvelopeVault, parseEnvelope } from "./crypto.ts";
import { GoogleOAuthError, refreshGoogleAccessToken } from "./google-oauth.ts";
import { GMAIL_SUBJECT_HASH_CONTEXT, GmailApiError, type GmailProvider } from "./providers/gmail.ts";
import type { RelayRepository, StoredAuditEvent, StoredMailAccount } from "./repository.ts";

const SYSTEM_INSTALLATION_ID = "relay-system-sync";
const POLICY_VERSION = 1;
const oauthClient = new OAuth2Client();

export type GmailSyncDependencies = Readonly<{
  repository: RelayRepository;
  vault: EnvelopeVault;
  config: RuntimeConfig & { googleClientId: string; googleClientSecret: string };
  adapter: GmailProvider;
  fetcher?: typeof fetch;
}>;

function buildAuditEvent(
  userId: string,
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
    installationId: SYSTEM_INSTALLATION_ID,
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

export type IdTokenVerifier = (
  idToken: string,
  audience: string,
) => Promise<Readonly<{ email?: string; email_verified?: boolean; iss?: string }> | null>;

const defaultVerifier: IdTokenVerifier = async (idToken, audience) => {
  const ticket = await oauthClient.verifyIdToken({ idToken, audience });
  return ticket.getPayload() ?? null;
};

/**
 * Verifies a Pub/Sub push request's OIDC bearer token: signature, issuer,
 * audience, and that it was signed by the exact service account configured
 * for this push subscription. Never trusts an unauthenticated POST body.
 * `verifier` defaults to real Google ID-token verification (network JWKS
 * fetch); tests inject a fake to avoid a real network dependency.
 */
export async function verifyPubSubPushToken(
  idToken: string,
  expectedAudience: string,
  expectedServiceAccountEmail: string,
  verifier: IdTokenVerifier = defaultVerifier,
): Promise<boolean> {
  try {
    const payload = await verifier(idToken, expectedAudience);
    return (
      !!payload &&
      payload.email === expectedServiceAccountEmail &&
      payload.email_verified === true &&
      payload.iss === "https://accounts.google.com"
    );
  } catch {
    return false;
  }
}

async function getFreshAccessToken(
  deps: GmailSyncDependencies,
  account: StoredMailAccount,
): Promise<string> {
  if (!account.credentialEnvelope) throw new GoogleOAuthError("GOOGLE_REFRESH_TOKEN_MISSING", 409);
  const refreshToken = await deps.vault.open(
    parseEnvelope(account.credentialEnvelope),
    credentialContext("gmail", account.userId, account.id),
  );
  const tokens = await refreshGoogleAccessToken(deps.config, refreshToken, deps.fetcher ?? fetch);
  return tokens.accessToken;
}

/**
 * Advances one account's history cursor. On a too-old `startHistoryId`
 * (Gmail returns 404), falls back to accepting the notification's own
 * `historyId` as the new cursor -- there is no message corpus to backfill,
 * so a full resync means only "trust the latest cursor going forward."
 */
export async function reconcileAccountHistory(
  deps: GmailSyncDependencies,
  account: StoredMailAccount,
  notifiedHistoryId: string,
  requestId: string,
): Promise<void> {
  const now = new Date().toISOString();
  try {
    const accessToken = await getFreshAccessToken(deps, account);
    const startHistoryId = account.historyId ?? notifiedHistoryId;
    let recordCount = 0;
    let latestHistoryId = startHistoryId;
    let pageToken: string | undefined;
    let fullResync = false;
    try {
      do {
        const page = await deps.adapter.historyList(accessToken, startHistoryId, pageToken);
        recordCount += page.recordCount;
        latestHistoryId = page.historyId;
        pageToken = page.nextPageToken ?? undefined;
      } while (pageToken);
    } catch (error) {
      if (error instanceof GmailApiError && error.code === "NOT_FOUND") {
        fullResync = true;
        latestHistoryId = notifiedHistoryId;
      } else {
        throw error;
      }
    }

    await deps.repository.updateAccountHistoryId(account.userId, account.id, latestHistoryId);
    await deps.repository.upsertSyncState({
      accountId: account.id,
      userId: account.userId,
      watchExpiresAt: (await deps.repository.getSyncState(account.id))?.watchExpiresAt ?? null,
      lastNotificationAt: now,
      lastReconciledAt: now,
      health: "active",
      createdAt: now,
      updatedAt: now,
    });
    await deps.repository.appendAudit(
      buildAuditEvent(
        account.userId,
        account.id,
        "account.history_synced",
        "changed",
        fullResync ? "FULL_RESYNC" : "OK",
        requestId,
        recordCount,
        "success",
      ),
    );
  } catch (error) {
    const reason =
      error instanceof GoogleOAuthError || (error instanceof GmailApiError && error.code === "UNAUTHORIZED")
        ? "reauthorization_required"
        : "provider_error";
    await deps.repository.setAccountHealth(account.userId, account.id, reason);
    await deps.repository.appendAudit(
      buildAuditEvent(
        account.userId,
        account.id,
        "account.history_synced",
        "blocked",
        reason === "reauthorization_required" ? "REAUTHORIZATION_REQUIRED" : "PROVIDER_ERROR",
        requestId,
        null,
        "failed",
      ),
    );
  }
}

/** Resolves a Pub/Sub notification's plaintext Gmail address to Relay accounts and reconciles each. */
export async function handleGmailPushNotification(
  deps: GmailSyncDependencies,
  emailAddress: string,
  notifiedHistoryId: string,
  requestId: string,
): Promise<number> {
  const subjectHash = await deps.vault.fingerprint(
    emailAddress.toLowerCase(),
    GMAIL_SUBJECT_HASH_CONTEXT,
  );
  const accounts = await deps.repository.findAccountsByProviderSubjectHash("gmail", subjectHash);
  for (const account of accounts) {
    await reconcileAccountHistory(deps, account, notifiedHistoryId, requestId);
  }
  return accounts.length;
}

/** Re-registers `users.watch` for one account and records the new expiry. */
export async function renewWatchForAccount(
  deps: GmailSyncDependencies,
  account: StoredMailAccount,
  topicName: string,
  requestId: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  try {
    const accessToken = await getFreshAccessToken(deps, account);
    const result = await deps.adapter.watch(accessToken, topicName);
    const existing = await deps.repository.getSyncState(account.id);
    await deps.repository.upsertSyncState({
      accountId: account.id,
      userId: account.userId,
      watchExpiresAt: new Date(Number(result.expiration)).toISOString(),
      lastNotificationAt: existing?.lastNotificationAt ?? null,
      lastReconciledAt: existing?.lastReconciledAt ?? null,
      health: "active",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    await deps.repository.appendAudit(
      buildAuditEvent(account.userId, account.id, "account.watch_renewed", "changed", "OK", requestId),
    );
    return true;
  } catch {
    const existing = await deps.repository.getSyncState(account.id);
    await deps.repository.upsertSyncState({
      accountId: account.id,
      userId: account.userId,
      watchExpiresAt: existing?.watchExpiresAt ?? null,
      lastNotificationAt: existing?.lastNotificationAt ?? null,
      lastReconciledAt: existing?.lastReconciledAt ?? null,
      health: "provider_error",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    await deps.repository.appendAudit(
      buildAuditEvent(
        account.userId,
        account.id,
        "account.watch_renewed",
        "blocked",
        "PROVIDER_ERROR",
        requestId,
        null,
        "failed",
      ),
    );
    return false;
  }
}

export async function renewAllWatches(
  deps: GmailSyncDependencies,
  topicName: string,
  requestId: string,
): Promise<Readonly<{ renewed: number; failed: number }>> {
  const accounts = await deps.repository.listAllConnectedAccounts("gmail");
  let renewed = 0;
  let failed = 0;
  for (const account of accounts) {
    if (await renewWatchForAccount(deps, account, topicName, requestId)) renewed += 1;
    else failed += 1;
  }
  return { renewed, failed };
}
