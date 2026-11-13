import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { getDb } from "../../db/index.ts";
import { assertStoredAuditEventSafe } from "./audit.ts";
import {
  relayAccountGrants,
  relayAccounts,
  relayApprovalEnvelopes,
  relayAuditEvents,
  relayInstallations,
  relayRateLimits,
  relaySyncState,
} from "../../db/schema.ts";
import type {
  AccountHealth,
  MailProvider,
  RelayRepository,
  StoredAccountGrant,
  StoredApprovalEnvelope,
  StoredAuditEvent,
  StoredGrantConstraints,
  StoredInstallation,
  StoredMailAccount,
  StoredSyncState,
} from "./repository.ts";

type RelayDb = Awaited<ReturnType<typeof getDb>>;

const toAccount = (row: typeof relayAccounts.$inferSelect): StoredMailAccount => ({
  ...row,
  provider: row.provider as MailProvider,
  scopes: row.scopes,
  state: row.state as StoredMailAccount["state"],
  health: row.health as StoredMailAccount["health"],
});

const toAudit = (row: typeof relayAuditEvents.$inferSelect): StoredAuditEvent => ({
  ...row,
});

const toInstallation = (row: typeof relayInstallations.$inferSelect): StoredInstallation => ({
  ...row,
});

const toAccountGrant = (row: typeof relayAccountGrants.$inferSelect): StoredAccountGrant => ({
  ...row,
  constraints: row.constraints as StoredGrantConstraints,
});

const toApproval = (row: typeof relayApprovalEnvelopes.$inferSelect): StoredApprovalEnvelope => ({
  ...row,
});

const toSyncState = (row: typeof relaySyncState.$inferSelect): StoredSyncState => ({
  ...row,
});

export class LibsqlRelayRepository implements RelayRepository {
  private readonly db: RelayDb;

  constructor(db: RelayDb) {
    this.db = db;
  }

  async listAccounts(userId: string): Promise<readonly StoredMailAccount[]> {
    const rows = await this.db
      .select()
      .from(relayAccounts)
      .where(and(eq(relayAccounts.userId, userId), eq(relayAccounts.state, "connected")))
      .orderBy(desc(relayAccounts.createdAt));
    return rows.map(toAccount);
  }

  async getAccount(userId: string, accountId: string): Promise<StoredMailAccount | null> {
    const [row] = await this.db
      .select()
      .from(relayAccounts)
      .where(and(eq(relayAccounts.userId, userId), eq(relayAccounts.id, accountId)))
      .limit(1);
    return row ? toAccount(row) : null;
  }

  async findAccountByProviderSubject(
    userId: string,
    provider: MailProvider,
    providerSubjectHash: string,
  ): Promise<StoredMailAccount | null> {
    const [row] = await this.db
      .select()
      .from(relayAccounts)
      .where(
        and(
          eq(relayAccounts.userId, userId),
          eq(relayAccounts.provider, provider),
          eq(relayAccounts.providerSubjectHash, providerSubjectHash),
        ),
      )
      .limit(1);
    return row ? toAccount(row) : null;
  }

  async upsertAccount(account: StoredMailAccount): Promise<void> {
    await this.db
      .insert(relayAccounts)
      .values({ ...account, scopes: [...account.scopes] })
      .onConflictDoUpdate({
        target: relayAccounts.id,
        set: {
          encryptedAddress: account.encryptedAddress,
          credentialEnvelope: account.credentialEnvelope,
          scopes: [...account.scopes],
          paused: account.paused,
          state: account.state,
          health: account.health,
          historyId: account.historyId,
          updatedAt: account.updatedAt,
          disconnectedAt: account.disconnectedAt,
        },
      });
  }

  async setAccountPaused(userId: string, accountId: string, paused: boolean): Promise<boolean> {
    const rows = await this.db
      .update(relayAccounts)
      .set({ paused, updatedAt: new Date().toISOString() })
      .where(and(eq(relayAccounts.userId, userId), eq(relayAccounts.id, accountId)))
      .returning({ id: relayAccounts.id });
    return rows.length === 1;
  }

  async setAccountHealth(
    userId: string,
    accountId: string,
    health: AccountHealth,
  ): Promise<boolean> {
    const rows = await this.db
      .update(relayAccounts)
      .set({ health, updatedAt: new Date().toISOString() })
      .where(and(eq(relayAccounts.userId, userId), eq(relayAccounts.id, accountId)))
      .returning({ id: relayAccounts.id });
    return rows.length === 1;
  }

  async finishDisconnect(
    userId: string,
    accountId: string,
    state: "disconnected" | "revocation_pending",
  ): Promise<boolean> {
    const now = new Date().toISOString();
    const rows = await this.db
      .update(relayAccounts)
      .set({
        paused: true,
        state,
        health: state === "disconnected" ? "healthy" : "revocation_pending",
        credentialEnvelope: state === "disconnected" ? null : undefined,
        // On a terminal disconnect, crypto-shred the encrypted address too, so
        // the disconnected tombstone retains no decryptable PII (only a keyed,
        // non-reversible subject hash and content-free audit rows remain).
        // Disconnected rows are never decrypted -- every read path is gated on
        // state === "connected".
        encryptedAddress: state === "disconnected" ? "" : undefined,
        disconnectedAt: now,
        updatedAt: now,
      })
      .where(and(eq(relayAccounts.userId, userId), eq(relayAccounts.id, accountId)))
      .returning({ id: relayAccounts.id });
    if (rows.length !== 1) return false;
    // Remove any AI-client grants to this account so no installation retains
    // access to it once it is disconnected.
    await this.db.delete(relayAccountGrants).where(eq(relayAccountGrants.accountId, accountId));
    return true;
  }

  async consumeRateLimit(
    userId: string,
    accountId: string,
    operation: string,
    limit: number,
    windowSeconds: number,
    now = new Date(),
  ): Promise<Readonly<{ allowed: boolean; remaining: number; resetAt: string }>> {
    const windowMilliseconds = windowSeconds * 1000;
    const windowId = Math.floor(now.getTime() / windowMilliseconds);
    const key = `${userId}:${accountId}:${operation}:${windowId}`;
    const [row] = await this.db
      .insert(relayRateLimits)
      .values({ key, userId, accountId, operation, windowId, count: 1 })
      .onConflictDoUpdate({
        target: relayRateLimits.key,
        set: {
          count: sql`${relayRateLimits.count} + 1`,
          updatedAt: now.toISOString(),
        },
      })
      .returning({ count: relayRateLimits.count });
    const count = row?.count ?? limit + 1;
    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      resetAt: new Date((windowId + 1) * windowMilliseconds).toISOString(),
    };
  }

  async appendAudit(event: StoredAuditEvent): Promise<void> {
    assertStoredAuditEventSafe(event);
    await this.db.insert(relayAuditEvents).values({
      ...event,
      resultCount: event.resultCount ?? undefined,
      providerResultClass: event.providerResultClass ?? undefined,
      accountId: event.accountId ?? undefined,
    });
  }

  async listAudit(userId: string, limit: number): Promise<readonly StoredAuditEvent[]> {
    const rows = await this.db
      .select()
      .from(relayAuditEvents)
      .where(eq(relayAuditEvents.userId, userId))
      .orderBy(desc(relayAuditEvents.occurredAt))
      .limit(Math.min(Math.max(limit, 1), 100));
    return rows.map(toAudit);
  }

  async getOrCreateInstallation(
    userId: string,
    clientId: string,
    clientName: string | null,
  ): Promise<Readonly<{ installation: StoredInstallation; created: boolean }>> {
    const [existing] = await this.db
      .select()
      .from(relayInstallations)
      .where(
        and(eq(relayInstallations.userId, userId), eq(relayInstallations.clientId, clientId)),
      )
      .limit(1);
    if (existing) return { installation: toInstallation(existing), created: false };

    const now = new Date().toISOString();
    const row = {
      id: crypto.randomUUID(),
      userId,
      clientId,
      clientName,
      revoked: false,
      revocationEpoch: 1,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
    };
    const [inserted] = await this.db
      .insert(relayInstallations)
      .values(row)
      .onConflictDoNothing({ target: [relayInstallations.userId, relayInstallations.clientId] })
      .returning();
    if (inserted) return { installation: toInstallation(inserted), created: true };

    // Lost a concurrent creation race: the other request's row is now current.
    const [current] = await this.db
      .select()
      .from(relayInstallations)
      .where(
        and(eq(relayInstallations.userId, userId), eq(relayInstallations.clientId, clientId)),
      )
      .limit(1);
    return { installation: toInstallation(current ?? row), created: false };
  }

  async listInstallations(userId: string): Promise<readonly StoredInstallation[]> {
    const rows = await this.db
      .select()
      .from(relayInstallations)
      .where(eq(relayInstallations.userId, userId))
      .orderBy(desc(relayInstallations.createdAt));
    return rows.map(toInstallation);
  }

  async getInstallation(
    userId: string,
    installationId: string,
  ): Promise<StoredInstallation | null> {
    const [row] = await this.db
      .select()
      .from(relayInstallations)
      .where(
        and(eq(relayInstallations.userId, userId), eq(relayInstallations.id, installationId)),
      )
      .limit(1);
    return row ? toInstallation(row) : null;
  }

  async setInstallationName(
    userId: string,
    installationId: string,
    clientName: string,
  ): Promise<boolean> {
    const rows = await this.db
      .update(relayInstallations)
      .set({ clientName, updatedAt: new Date().toISOString() })
      .where(
        and(eq(relayInstallations.userId, userId), eq(relayInstallations.id, installationId)),
      )
      .returning({ id: relayInstallations.id });
    return rows.length === 1;
  }

  async setInstallationRevoked(
    userId: string,
    installationId: string,
    revoked: boolean,
  ): Promise<boolean> {
    const rows = await this.db
      .update(relayInstallations)
      .set({
        revoked,
        revocationEpoch: sql`${relayInstallations.revocationEpoch} + 1`,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(eq(relayInstallations.userId, userId), eq(relayInstallations.id, installationId)),
      )
      .returning({ id: relayInstallations.id });
    return rows.length === 1;
  }

  async touchInstallation(installationId: string): Promise<void> {
    await this.db
      .update(relayInstallations)
      .set({ lastSeenAt: new Date().toISOString() })
      .where(eq(relayInstallations.id, installationId));
  }

  async upsertAccountGrant(
    installationId: string,
    accountId: string,
    permissions: Readonly<Record<string, boolean>>,
    constraints: StoredGrantConstraints,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .insert(relayAccountGrants)
      .values({
        id: crypto.randomUUID(),
        installationId,
        accountId,
        permissions: { ...permissions },
        constraints: { ...constraints, deniedLabelIds: [...constraints.deniedLabelIds] },
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [relayAccountGrants.installationId, relayAccountGrants.accountId],
        set: {
          permissions: { ...permissions },
          constraints: { ...constraints, deniedLabelIds: [...constraints.deniedLabelIds] },
          updatedAt: now,
        },
      });
  }

  async revokeAccountGrant(installationId: string, accountId: string): Promise<boolean> {
    const rows = await this.db
      .delete(relayAccountGrants)
      .where(
        and(
          eq(relayAccountGrants.installationId, installationId),
          eq(relayAccountGrants.accountId, accountId),
        ),
      )
      .returning({ id: relayAccountGrants.id });
    return rows.length === 1;
  }

  async listAccountGrants(installationId: string): Promise<readonly StoredAccountGrant[]> {
    const rows = await this.db
      .select()
      .from(relayAccountGrants)
      .where(eq(relayAccountGrants.installationId, installationId));
    return rows.map(toAccountGrant);
  }

  async getAccountGrant(
    installationId: string,
    accountId: string,
  ): Promise<StoredAccountGrant | null> {
    const [row] = await this.db
      .select()
      .from(relayAccountGrants)
      .where(
        and(
          eq(relayAccountGrants.installationId, installationId),
          eq(relayAccountGrants.accountId, accountId),
        ),
      )
      .limit(1);
    return row ? toAccountGrant(row) : null;
  }

  async createApprovalEnvelope(envelope: StoredApprovalEnvelope): Promise<void> {
    await this.db.insert(relayApprovalEnvelopes).values({ ...envelope });
  }

  async getApprovalEnvelope(userId: string, id: string): Promise<StoredApprovalEnvelope | null> {
    const [row] = await this.db
      .select()
      .from(relayApprovalEnvelopes)
      .where(and(eq(relayApprovalEnvelopes.userId, userId), eq(relayApprovalEnvelopes.id, id)))
      .limit(1);
    if (!row) return null;
    if (new Date(row.expiresAt).getTime() <= Date.now()) {
      await this.db.delete(relayApprovalEnvelopes).where(eq(relayApprovalEnvelopes.id, id));
      return null;
    }
    return toApproval(row);
  }

  async listApprovalEnvelopes(userId: string): Promise<readonly StoredApprovalEnvelope[]> {
    const now = new Date().toISOString();
    await this.db
      .delete(relayApprovalEnvelopes)
      .where(
        and(
          eq(relayApprovalEnvelopes.userId, userId),
          sql`${relayApprovalEnvelopes.expiresAt} <= ${now}`,
        ),
      );
    const rows = await this.db
      .select()
      .from(relayApprovalEnvelopes)
      .where(
        and(eq(relayApprovalEnvelopes.userId, userId), gt(relayApprovalEnvelopes.expiresAt, now)),
      )
      .orderBy(desc(relayApprovalEnvelopes.createdAt));
    return rows.map(toApproval);
  }

  async transitionApprovalEnvelope(
    userId: string,
    id: string,
    fromStates: readonly string[],
    toState: string,
    notExpiredAsOf?: string,
  ): Promise<boolean> {
    const rows = await this.db
      .update(relayApprovalEnvelopes)
      .set({ state: toState, updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(relayApprovalEnvelopes.userId, userId),
          eq(relayApprovalEnvelopes.id, id),
          inArray(relayApprovalEnvelopes.state, [...fromStates]),
          ...(notExpiredAsOf
            ? [gt(relayApprovalEnvelopes.expiresAt, notExpiredAsOf)]
            : []),
        ),
      )
      .returning({ id: relayApprovalEnvelopes.id });
    return rows.length === 1;
  }

  async deleteApprovalEnvelope(userId: string, id: string): Promise<void> {
    await this.db
      .delete(relayApprovalEnvelopes)
      .where(and(eq(relayApprovalEnvelopes.userId, userId), eq(relayApprovalEnvelopes.id, id)));
  }

  async findAccountsByProviderSubjectHash(
    provider: MailProvider,
    providerSubjectHash: string,
  ): Promise<readonly StoredMailAccount[]> {
    const rows = await this.db
      .select()
      .from(relayAccounts)
      .where(
        and(
          eq(relayAccounts.provider, provider),
          eq(relayAccounts.providerSubjectHash, providerSubjectHash),
          eq(relayAccounts.state, "connected"),
          eq(relayAccounts.paused, false),
        ),
      );
    return rows.map(toAccount);
  }

  async listAllConnectedAccounts(provider: MailProvider): Promise<readonly StoredMailAccount[]> {
    const rows = await this.db
      .select()
      .from(relayAccounts)
      .where(
        and(
          eq(relayAccounts.provider, provider),
          eq(relayAccounts.state, "connected"),
          eq(relayAccounts.paused, false),
        ),
      );
    return rows.map(toAccount);
  }

  async updateAccountHistoryId(userId: string, accountId: string, historyId: string): Promise<void> {
    await this.db
      .update(relayAccounts)
      .set({ historyId, updatedAt: new Date().toISOString() })
      .where(and(eq(relayAccounts.userId, userId), eq(relayAccounts.id, accountId)));
  }

  async updateAccountCredential(
    userId: string,
    accountId: string,
    credentialEnvelope: string,
  ): Promise<void> {
    await this.db
      .update(relayAccounts)
      .set({ credentialEnvelope, updatedAt: new Date().toISOString() })
      .where(and(eq(relayAccounts.userId, userId), eq(relayAccounts.id, accountId)));
  }

  async getSyncState(accountId: string): Promise<StoredSyncState | null> {
    const [row] = await this.db
      .select()
      .from(relaySyncState)
      .where(eq(relaySyncState.accountId, accountId))
      .limit(1);
    return row ? toSyncState(row) : null;
  }

  async upsertSyncState(state: StoredSyncState): Promise<void> {
    await this.db
      .insert(relaySyncState)
      .values({ ...state })
      .onConflictDoUpdate({
        target: relaySyncState.accountId,
        set: {
          watchExpiresAt: state.watchExpiresAt,
          lastNotificationAt: state.lastNotificationAt,
          lastReconciledAt: state.lastReconciledAt,
          health: state.health,
          updatedAt: state.updatedAt,
        },
      });
  }
}
