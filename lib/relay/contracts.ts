export const MAIL_PERMISSIONS = [
  "search",
  "read_body",
  "draft",
  "send",
] as const;

export type MailPermission = (typeof MAIL_PERMISSIONS)[number];

export const MAIL_OPERATIONS = [
  "mail.search",
  "mail.message.get",
  "mail.thread.get",
  "mail.draft.create",
  "mail.draft.update",
  "mail.send.request_approval",
  "mail.send.dispatch",
] as const;

export type MailOperation = (typeof MAIL_OPERATIONS)[number];
export type Provider = "gmail" | "microsoft";

export type RelayIdentity = Readonly<{
  tenantId: string;
  userId: string;
  installationId: string;
  clientId: string;
}>;

export type PolicyConstraints = Readonly<{
  deniedLabelIds: readonly string[];
  maxResults: number;
  maxBytes: number;
}>;

export type AccountGrant = Readonly<{
  accountId: string;
  permissions: Readonly<Record<MailPermission, boolean>>;
  constraints: PolicyConstraints;
  paused: boolean;
}>;

export type PolicySnapshot = Readonly<{
  tenantId: string;
  userId: string;
  installationId: string;
  policyVersion: number;
  revocationEpoch: number;
  globallyPaused: boolean;
  accounts: readonly AccountGrant[];
}>;

export type AuthorizationRequest = Readonly<{
  identity: RelayIdentity;
  accountId: string;
  operation: MailOperation;
  observedRevocationEpoch?: number;
}>;

export type AuthorizationContext = Readonly<{
  tenantId: string;
  userId: string;
  installationId: string;
  clientId: string;
  accountId: string;
  operation: MailOperation;
  policyVersion: number;
  revocationEpoch: number;
  constraints: PolicyConstraints;
  issuedAt: string;
}>;

export const permissionForOperation = (
  operation: MailOperation,
): MailPermission => {
  switch (operation) {
    case "mail.search":
      return "search";
    case "mail.message.get":
    case "mail.thread.get":
      return "read_body";
    case "mail.draft.create":
    case "mail.draft.update":
      return "draft";
    case "mail.send.request_approval":
    case "mail.send.dispatch":
      return "send";
  }
};
