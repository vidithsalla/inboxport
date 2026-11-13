import type { z } from "zod";
import type { AuthorizationContext, MailOperation } from "./contracts.ts";

/**
 * Gmail's draft builder interpolates to/cc/bcc/subject/in_reply_to directly
 * into raw MIME header lines (To:/Cc:/Bcc:/Subject:/In-Reply-To:/References:).
 * A bare CR or LF is a header terminator in RFC 5322 -- letting one through
 * would let a caller inject an additional header (e.g. a hidden Bcc) that
 * never appears in the fields the approval preview actually reviews.
 * Applied at the MCP tool schema boundary (mcp/server.ts), before any MIME
 * or Graph JSON is built, for both providers. Lives here rather than in
 * mcp/server.ts so it stays testable without pulling in that module's
 * transitive dependency on @clerk/nextjs/server.
 */
export const noHeaderInjection = <T extends z.ZodString>(schema: T) =>
  schema.refine((value) => !/[\r\n]/.test(value), { message: "must not contain a line break" });

export type ProviderDraftInput = Readonly<{
  to: readonly string[];
  cc: readonly string[];
  bcc: readonly string[];
  subject: string;
  body: Readonly<{ format: "text" | "html"; content: string }>;
  inReplyTo?: string;
  threadId?: string;
}>;

/**
 * Provider-neutral shapes the MCP layer and send-approval flow operate on.
 * Gmail's existing GmailSearchResult/GmailMessage/GmailThread/GmailDraftResult/
 * GmailDraftContent already satisfy these structurally -- gmail.ts needed no
 * changes to conform. `labelIds` is Gmail-only (Outlook has no equivalent);
 * it is optional here rather than provider-specific because nothing
 * downstream requires it -- MCP tool responses just pass search results
 * through as-is.
 */
export type MailSearchResult = Readonly<{
  id: string;
  threadId: string;
  internalDate: string | null;
  from: string | null;
  subject: string | null;
  date: string | null;
  snippet: string;
  labelIds?: readonly string[];
}>;

export type MailMessage = MailSearchResult &
  Readonly<{
    to: string | null;
    cc: string | null;
    bodyText: string;
    bodyTruncated: boolean;
  }>;

export type MailThread = Readonly<{
  id: string;
  historyId?: string | null;
  messages: readonly MailMessage[];
}>;

export type MailDraftResult = Readonly<{
  draftId: string;
  providerMessageId: string;
  threadId: string | null;
}>;

export type MailDraftContent = Readonly<{
  draftId: string;
  threadId: string | null;
  from: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  bodyText: string;
  bodyHtml: string;
  hasAttachments: boolean;
}>;

export function assertAdapterContext(
  context: AuthorizationContext,
  accountId: string,
  operation: MailOperation,
): void {
  if (context.accountId !== accountId) {
    throw new Error("ADAPTER_ACCOUNT_MISMATCH");
  }
  if (context.operation !== operation) {
    throw new Error("ADAPTER_OPERATION_MISMATCH");
  }
}
