import { type EnvelopeVault, parseEnvelope } from "./crypto.ts";
import type {
  MailProvider,
  RelayRepository,
  StoredAuditEvent,
  StoredMailAccount,
} from "./repository.ts";
import type { RequestUser } from "./request-user.ts";

/**
 * Provider-neutral account operations. Listing an account, mapping it to its
 * public view, and pausing it need only the database and the envelope vault --
 * never a provider's OAuth configuration. Keeping them here lets the console
 * serve, list, and pause accounts of any provider without requiring, say,
 * Google credentials just to read back an Outlook inbox.
 */

const CONSOLE_INSTALLATION_ID = "relay-web-console";
const POLICY_VERSION = 1;

export type PublicMailAccount = Readonly<{
  id: string;
  provider: MailProvider;
  address: string;
  paused: boolean;
  health: string;
  scopes: readonly string[];
  connectedAt: string;
}>;

/**
 * The single canonical form of these per-account vault contexts, shared by
 * every reader/writer of encrypted address and credential envelopes
 * (gmail-service.ts, outlook-service.ts, mail-tools-service.ts,
 * send-approval-service.ts). Must never change for an existing provider --
 * already-sealed envelopes were sealed under exactly this string.
 */
export const addressContext = (provider: MailProvider, userId: string, accountId: string) =>
  `relay-mail:address:${userId}:${accountId}:${provider}:v1`;
export const credentialContext = (provider: MailProvider, userId: string, accountId: string) =>
  `relay-mail:credential:${userId}:${accountId}:${provider}:v1`;

export async function toPublicAccount(
  vault: EnvelopeVault,
  account: StoredMailAccount,
): Promise<PublicMailAccount> {
  const address = await vault.open(
    parseEnvelope(account.encryptedAddress),
    addressContext(account.provider, account.userId, account.id),
  );
  return {
    id: account.id,
    provider: account.provider,
    address,
    paused: account.paused,
    health: account.health,
    scopes: account.scopes,
    connectedAt: account.createdAt,
  };
}

export async function listPublicAccounts(
  vault: EnvelopeVault,
  repository: RelayRepository,
  userId: string,
): Promise<readonly PublicMailAccount[]> {
  const accounts = await repository.listAccounts(userId);
  return Promise.all(accounts.map((account) => toPublicAccount(vault, account)));
}

/** Pauses or resumes any account by id, regardless of provider, with a content-free audit event. */
export async function pauseAccount(
  repository: RelayRepository,
  user: RequestUser,
  accountId: string,
  paused: boolean,
  requestId: string,
): Promise<boolean> {
  const changed = await repository.setAccountPaused(user.id, accountId, paused);
  if (changed) {
    const event: StoredAuditEvent = {
      id: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      userId: user.id,
      installationId: CONSOLE_INSTALLATION_ID,
      accountId,
      operation: "policy.update",
      decision: "changed",
      reasonCode: "POLICY_UPDATED",
      policyVersion: POLICY_VERSION,
      requestId,
      resultCount: null,
      providerResultClass: null,
    };
    await repository.appendAudit(event);
  }
  return changed;
}
