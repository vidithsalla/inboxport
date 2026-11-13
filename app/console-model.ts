export type Provider = "google" | "outlook" | "imap";
export type Permission = "metadata" | "body" | "drafts" | "send";

export type Account = Readonly<{
  id: string;
  provider: Provider;
  label: string;
  address: string;
  color: string;
  permissions: Readonly<Record<Permission, boolean>>;
  live: true;
  paused: boolean;
  health: string;
}>;

export type PublicAccountPayload = Readonly<{
  id: string;
  provider?: "gmail" | "microsoft";
  address: string;
  paused: boolean;
  health: string;
  scopes?: readonly string[];
}>;

export type AuditDecision = "allowed" | "blocked" | "changed";
export type AuditFilter = "all" | AuditDecision;

export type AuditEvent = Readonly<{
  id: string;
  occurredAt: string;
  installationId: string;
  accountId: string | null;
  operation: string;
  decision: AuditDecision;
  reasonCode: string;
  policyVersion: number;
  requestId: string;
  resultCount: number | null;
  providerResultClass: string | null;
}>;

const GMAIL_COMPOSE_SCOPE = "https://www.googleapis.com/auth/gmail.compose";

export function mapPublicAccounts(accounts: readonly PublicAccountPayload[]): Account[] {
  return accounts.map((account, index) => {
    const isOutlook = account.provider === "microsoft";
    const composeEnabled = isOutlook
      ? Boolean(account.scopes?.includes("Mail.ReadWrite") && account.scopes?.includes("Mail.Send"))
      : Boolean(account.scopes?.includes(GMAIL_COMPOSE_SCOPE));
    return {
      id: account.id,
      provider: isOutlook ? "outlook" : "google",
      label: account.address.split("@")[0] || (isOutlook ? "Outlook" : "Gmail"),
      address: account.address,
      color: ["coral", "blue", "violet", "mint"][index % 4],
      permissions: {
        metadata: true,
        body: true,
        drafts: composeEnabled,
        send: composeEnabled,
      },
      live: true,
      paused: account.paused,
      health: account.health,
    };
  });
}

const operationTitles: Readonly<Record<string, string>> = {
  "mail.search": "Mail search completed",
  "mail.message.get": "Message retrieved",
  "mail.thread.get": "Thread retrieved",
  "mail.draft.create": "Draft created",
  "mail.draft.update": "Draft updated",
  "mail.send.request_approval": "Send approval requested",
  "mail.send.dispatch": "Approved message dispatched",
  "policy.update": "Inbox policy changed",
  "account.disconnect": "Inbox disconnected",
  "installation.connect": "AI client connected",
  "installation.rename": "AI client renamed",
  "installation.revoke": "AI client access changed",
  "account.history_synced": "Mailbox history synchronized",
  "account.watch_renewed": "Mailbox watch renewed",
};

export function presentAuditEvent(
  event: AuditEvent,
  accountLabel?: string,
  installationLabel?: string,
): Readonly<{ title: string; text: string; tags: string[] }> {
  const title = operationTitles[event.operation] ?? event.operation;
  const decisionText =
    event.decision === "allowed"
      ? "InboxPort allowed this operation under the active policy."
      : event.decision === "blocked"
        ? `InboxPort blocked this operation (${event.reasonCode}).`
        : `InboxPort recorded a policy or connection change (${event.reasonCode}).`;
  const tags = [
    event.operation,
    ...(accountLabel ? [`inbox:${accountLabel}`] : []),
    ...(installationLabel ? [`client:${installationLabel}`] : []),
    ...(event.resultCount == null ? [] : [`${event.resultCount} result${event.resultCount === 1 ? "" : "s"}`]),
    ...(event.providerResultClass ? [`provider:${event.providerResultClass}`] : []),
  ];
  return { title, text: decisionText, tags };
}

export function filterAuditEvents(
  events: readonly AuditEvent[],
  filter: AuditFilter,
): readonly AuditEvent[] {
  return filter === "all" ? events : events.filter((event) => event.decision === filter);
}

export function serializeAuditEvents(events: readonly AuditEvent[]): string {
  return `${JSON.stringify({ exportedAt: new Date().toISOString(), events }, null, 2)}\n`;
}
