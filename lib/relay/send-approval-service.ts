import { addressContext } from "./account-view.ts";
import { parseEnvelope, serializeEnvelope } from "./crypto.ts";
import {
  SEND_ENVELOPE_MAX_TTL_MS,
  canonicalizeSendPayload,
  hashCanonicalSendPayload,
  serializeCanonicalSendPayload,
  transitionSendState,
  assertEnvelopeExpiry,
  type SendState,
} from "./send-envelope.ts";
import type { MailDraftContent } from "./provider-adapter.ts";
import { GmailApiError } from "./providers/gmail.ts";
import { OutlookApiError } from "./providers/outlook.ts";
import type { StoredApprovalEnvelope, StoredMailAccount } from "./repository.ts";
import {
  McpMailAccessError,
  assertComposeScope,
  buildAuditEvent,
  withAuthorizedAccount,
  type McpToolDependencies,
} from "./mcp/mail-tools-service.ts";

/** Signals the dispatch-time re-fetch found different content than what was approved. */
class ContentChangedError extends Error {}

export type ApprovalPreview = Readonly<{
  from: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: Readonly<{ format: "text" | "html"; content: string }>;
  hasAttachments: boolean;
}>;

/**
 * A human-readable body for the review card. The hash a human is implicitly
 * vouching for when they approve covers BOTH bodyText and bodyHtml (see
 * canonicalizeDraft below) -- so if a draft somehow has both populated with
 * genuinely different content, showing only one would let a human approve
 * content they never actually saw. Relay's own draft tools never produce a
 * dual-format draft (mail_draft_create/update always write exactly one
 * format) -- this only arises from a draft edited directly in the
 * provider's own UI after Relay created it. Rather than silently pick one
 * (previously: plaintext if present) or reject the draft outright, show
 * both, verbatim, so "what you approve" and "what the hash covers" are
 * provably the same thing.
 */
const displayBody = (
  bodyText: string,
  bodyHtml: string,
): ApprovalPreview["body"] => {
  if (bodyText.length > 0 && bodyHtml.length > 0) {
    return {
      format: "text",
      content: `${bodyText}\n\n--- This draft also has a separate HTML version below. Both are part of what will be sent and hashed. ---\n\n${bodyHtml}`,
    };
  }
  return bodyText.length > 0
    ? { format: "text", content: bodyText }
    : { format: "html", content: bodyHtml };
};

const toPreview = (draft: MailDraftContent, displayFrom: string): ApprovalPreview => ({
  from: displayFrom,
  to: draft.to,
  cc: draft.cc,
  bcc: draft.bcc,
  subject: draft.subject,
  body: displayBody(draft.bodyText, draft.bodyHtml),
  hasAttachments: draft.hasAttachments,
});

async function decryptAccountAddress(
  deps: McpToolDependencies,
  userId: string,
  account: StoredMailAccount,
): Promise<string> {
  return deps.vault.open(
    parseEnvelope(account.encryptedAddress),
    addressContext(account.provider, userId, account.id),
  );
}

/**
 * Builds the canonical, hashed representation of exactly what the provider
 * will send: the draft's own From (falling back to the account's send
 * address when the draft has none), every recipient, the subject, and both
 * body formats. Any post-approval change to any of these -- including only
 * the HTML alternative -- changes the hash and aborts the send. Gmail
 * commonly populates both bodyText and bodyHtml (multipart/alternative);
 * Outlook's Graph messages hold exactly one content type, so the other is
 * simply empty here -- there is no missing information, only whatever
 * content the draft actually has.
 */
function canonicalizeDraft(accountId: string, address: string, draft: MailDraftContent) {
  try {
    return canonicalizeSendPayload({
      accountId,
      from: draft.from || address,
      to: draft.to ? [draft.to] : [],
      cc: draft.cc ? [draft.cc] : [],
      bcc: draft.bcc ? [draft.bcc] : [],
      subject: draft.subject,
      bodyText: draft.bodyText,
      bodyHtml: draft.bodyHtml,
      inReplyTo: null,
      threadId: draft.threadId,
      attachments: draft.hasAttachments ? [{ note: "attachment detected on the live draft" }] : [],
    });
  } catch (error) {
    if (error instanceof Error && error.message === "ATTACHMENTS_NOT_SUPPORTED_IN_MVP") {
      throw new McpMailAccessError("ATTACHMENTS_NOT_SUPPORTED_IN_MVP", 400);
    }
    throw error;
  }
}

export type ApprovalSummary = Readonly<{
  approvalId: string;
  expiresAt: string;
  preview: ApprovalPreview;
  consoleUrl: string;
}>;

/**
 * A link straight to this one pending approval in the console, so the human
 * doesn't have to navigate to the Approvals tab and find it in a list. This
 * is convenience only: it still resolves to the same authenticated-session
 * page that is the actual point where a human, not any MCP tool, decides.
 */
function approvalConsoleUrl(appUrl: string, approvalId: string): string {
  const url = new URL("/", appUrl);
  url.searchParams.set("view", "approvals");
  url.searchParams.set("approval", approvalId);
  return url.toString();
}

/**
 * Fetches the draft's exact current content, canonicalizes and hashes it, and
 * stores an encrypted, single-use, ten-minute approval envelope. The AI
 * caller receives only an approval id and a preview -- it cannot approve its
 * own request. Only the human Relay user, from the console, can do that.
 */
export async function requestSendApproval(
  deps: McpToolDependencies,
  userId: string,
  installationId: string,
  clientId: string,
  accountId: string,
  providerDraftId: string,
  requestId: string,
): Promise<ApprovalSummary> {
  return withAuthorizedAccount(
    deps,
    userId,
    installationId,
    clientId,
    accountId,
    "mail.send.request_approval",
    requestId,
    async (accessToken, _context, account) => {
      assertComposeScope(account);
      const adapter = account.provider === "microsoft" ? deps.adapters.outlook : deps.adapters.gmail;
      const draft = await adapter.getDraft(accessToken, providerDraftId);
      const address = await decryptAccountAddress(deps, userId, account);
      const payload = canonicalizeDraft(account.id, address, draft);
      const hash = await hashCanonicalSendPayload(payload);

      const now = new Date();
      const expiresAt = new Date(now.getTime() + SEND_ENVELOPE_MAX_TTL_MS);
      assertEnvelopeExpiry(now, expiresAt);
      // Bound to this specific approval id (not just userId+accountId) so
      // two envelopes for the same account can never be swapped at the
      // storage layer without an authentication failure -- the same
      // per-record binding principle already used for credential/address
      // contexts, applied here to approval envelopes.
      const id = crypto.randomUUID();
      const sealed = await deps.vault.seal(
        serializeCanonicalSendPayload(payload),
        `relay-mail:approval:${userId}:${accountId}:${id}:v1`,
      );
      const envelope: StoredApprovalEnvelope = {
        id,
        userId,
        installationId,
        accountId,
        providerDraftId,
        payloadHash: hash,
        encryptedEnvelope: serializeEnvelope(sealed),
        state: "awaiting_approval",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      };
      await deps.repository.createApprovalEnvelope(envelope);
      await deps.repository.appendAudit(
        buildAuditEvent(
          userId,
          installationId,
          accountId,
          "mail.send.request_approval",
          "allowed",
          "OK",
          requestId,
          null,
          "success",
        ),
      );
      return {
        approvalId: id,
        expiresAt: envelope.expiresAt,
        preview: toPreview(draft, draft.from || address),
        consoleUrl: approvalConsoleUrl(deps.config.appUrl, id),
      };
    },
  );
}

export type PendingApproval = Readonly<{
  id: string;
  accountId: string;
  installationId: string;
  expiresAt: string;
  preview: ApprovalPreview;
}>;

/** Lists this user's pending approvals with the exact content a human must review before approving. */
export async function listPendingApprovals(
  deps: McpToolDependencies,
  userId: string,
): Promise<readonly PendingApproval[]> {
  const envelopes = await deps.repository.listApprovalEnvelopes(userId);
  return Promise.all(
    envelopes
      .filter((envelope) => envelope.state === "awaiting_approval")
      .map(async (envelope) => {
        const plaintext = await deps.vault.open(
          parseEnvelope(envelope.encryptedEnvelope),
          `relay-mail:approval:${userId}:${envelope.accountId}:${envelope.id}:v1`,
        );
        const payload = JSON.parse(plaintext) as {
          from: string;
          to: string[];
          cc: string[];
          bcc: string[];
          subject: string;
          bodyText: string;
          bodyHtml: string;
          attachments: unknown[];
        };
        return {
          id: envelope.id,
          accountId: envelope.accountId,
          installationId: envelope.installationId,
          expiresAt: envelope.expiresAt,
          preview: {
            from: payload.from,
            to: payload.to.join(", "),
            cc: payload.cc.join(", "),
            bcc: payload.bcc.join(", "),
            subject: payload.subject,
            body: displayBody(payload.bodyText, payload.bodyHtml),
            hasAttachments: payload.attachments.length > 0,
          },
        };
      }),
  );
}

export type ApprovalDecision = "approve" | "deny" | "cancel";
export type ApprovalResolution = Readonly<{
  state: "sent" | "denied" | "cancelled" | "failed" | "delivery_unknown";
  providerMessageId?: string;
}>;

async function finalizeNonApprove(
  deps: McpToolDependencies,
  userId: string,
  envelope: StoredApprovalEnvelope,
  toState: Extract<SendState, "denied" | "cancelled">,
  requestId: string,
): Promise<ApprovalResolution> {
  transitionSendState(envelope.state as SendState, toState);
  const changed = await deps.repository.transitionApprovalEnvelope(
    userId,
    envelope.id,
    ["awaiting_approval"],
    toState,
  );
  if (!changed) throw new McpMailAccessError("APPROVAL_NOT_PENDING", 409);
  await deps.repository.deleteApprovalEnvelope(userId, envelope.id);
  await deps.repository.appendAudit(
    buildAuditEvent(
      userId,
      envelope.installationId,
      envelope.accountId,
      "mail.send.dispatch",
      "changed",
      toState === "denied" ? "SEND_DENIED" : "SEND_CANCELLED",
      requestId,
    ),
  );
  return { state: toState };
}

/**
 * Only callable from the trusted console surface (a Clerk-authenticated
 * human), never from an MCP tool -- there is deliberately no "approve" MCP
 * tool. Approving re-authorizes, re-fetches the draft, and re-hashes it
 * before ever calling the provider's send endpoint; any mismatch or authorization
 * failure aborts without sending. A network-level failure during the send
 * call itself (as opposed to a clean HTTP error response) is recorded as
 * `delivery_unknown` and is never retried automatically.
 */
export async function resolveSendApproval(
  deps: McpToolDependencies,
  userId: string,
  approvalId: string,
  decision: ApprovalDecision,
  requestId: string,
): Promise<ApprovalResolution> {
  const envelope = await deps.repository.getApprovalEnvelope(userId, approvalId);
  if (!envelope) throw new McpMailAccessError("APPROVAL_NOT_FOUND", 404);
  if (envelope.state !== "awaiting_approval") throw new McpMailAccessError("APPROVAL_NOT_PENDING", 409);

  if (decision === "deny") return finalizeNonApprove(deps, userId, envelope, "denied", requestId);
  if (decision === "cancel") return finalizeNonApprove(deps, userId, envelope, "cancelled", requestId);

  transitionSendState("awaiting_approval", "approved");
  // Atomic with expiry: an envelope that has aged past its ten-minute window
  // between the read above and now cannot be moved forward toward sending.
  const approvedOk = await deps.repository.transitionApprovalEnvelope(
    userId,
    approvalId,
    ["awaiting_approval"],
    "approved",
    new Date().toISOString(),
  );
  if (!approvedOk) throw new McpMailAccessError("APPROVAL_NOT_PENDING", 409);

  const installation = await deps.repository.getInstallation(userId, envelope.installationId);
  if (!installation) {
    await deps.repository.transitionApprovalEnvelope(userId, approvalId, ["approved"], "cancelled");
    await deps.repository.deleteApprovalEnvelope(userId, approvalId);
    throw new McpMailAccessError("INSTALLATION_NOT_FOUND", 404);
  }

  try {
    return await withAuthorizedAccount(
      deps,
      userId,
      envelope.installationId,
      installation.clientId,
      envelope.accountId,
      "mail.send.dispatch",
      requestId,
      async (accessToken, _context, account) => {
        assertComposeScope(account);
        const adapter = account.provider === "microsoft" ? deps.adapters.outlook : deps.adapters.gmail;
        const draft = await adapter.getDraft(accessToken, envelope.providerDraftId);
        const address = await decryptAccountAddress(deps, userId, account);
        const payload = canonicalizeDraft(account.id, address, draft);
        const freshHash = await hashCanonicalSendPayload(payload);
        if (freshHash !== envelope.payloadHash) throw new ContentChangedError();

        const dispatchOk = await deps.repository.transitionApprovalEnvelope(
          userId,
          approvalId,
          ["approved"],
          "dispatching",
          new Date().toISOString(),
        );
        if (!dispatchOk) throw new McpMailAccessError("APPROVAL_NOT_PENDING", 409);

        try {
          const sent = await adapter.sendDraft(accessToken, envelope.providerDraftId);
          // The provider has confirmed the send. Everything from here is
          // bookkeeping, not the dispatch itself -- a Turso hiccup on any of
          // these calls must never be able to fall into the catch below and
          // get reclassified as the send having failed or being ambiguous,
          // which would erase the one record (delivery_unknown) that exists
          // specifically to survive this kind of failure. Best-effort only;
          // a lingering "dispatching" row or a missing audit entry is a far
          // smaller problem than silently discarding proof of a real send.
          try {
            await deps.repository.transitionApprovalEnvelope(userId, approvalId, ["dispatching"], "sent");
            await deps.repository.deleteApprovalEnvelope(userId, approvalId);
            await deps.repository.appendAudit(
              buildAuditEvent(
                userId,
                envelope.installationId,
                envelope.accountId,
                "mail.send.dispatch",
                "allowed",
                "OK",
                requestId,
                1,
                "success",
              ),
            );
          } catch {
            // Do not log the raw datastore exception. Driver errors may embed
            // connection URLs or credentials; the request id is sufficient to
            // correlate this best-effort bookkeeping failure safely.
            console.error(
              "post-send bookkeeping failed after a confirmed successful send",
              { approvalId, requestId },
            );
          }
          return { state: "sent" as const, providerMessageId: sent.providerMessageId };
        } catch (sendError) {
          // Only a proven pre-delivery rejection (the provider refused the request
          // with a definitive 4xx) may be marked `failed`. A 5xx, a malformed 2xx we
          // could not parse, or any transport/network error is genuinely
          // ambiguous -- the provider may already have delivered the message -- so
          // it becomes `delivery_unknown` and is never retried automatically.
          // Classify by the actual HTTP status, not the collapsed `code` enum --
          // both adapters fold every status outside {401,403,404,429} into a
          // generic UPSTREAM_FAILED code, which used to swallow definite
          // rejections like 400 (malformed request) or 422 (unprocessable
          // recipients) into the ambiguous bucket even though a 4xx response
          // means the provider rejected the request outright and never
          // attempted delivery, same as the explicitly-named codes below.
          const definiteRejection =
            (sendError instanceof GmailApiError || sendError instanceof OutlookApiError) &&
            sendError.status >= 400 &&
            sendError.status < 500;
          if (definiteRejection) {
            await deps.repository.transitionApprovalEnvelope(userId, approvalId, ["dispatching"], "failed");
            await deps.repository.deleteApprovalEnvelope(userId, approvalId);
            await deps.repository.appendAudit(
              buildAuditEvent(
                userId,
                envelope.installationId,
                envelope.accountId,
                "mail.send.dispatch",
                "blocked",
                "SEND_FAILED",
                requestId,
                null,
                "failed",
              ),
            );
            return { state: "failed" as const };
          }
          // Ambiguous: the request may or may not have reached Gmail. Never retried automatically.
          await deps.repository.transitionApprovalEnvelope(
            userId,
            approvalId,
            ["dispatching"],
            "delivery_unknown",
          );
          await deps.repository.appendAudit(
            buildAuditEvent(
              userId,
              envelope.installationId,
              envelope.accountId,
              "mail.send.dispatch",
              "changed",
              "DELIVERY_UNKNOWN",
              requestId,
              null,
              "unknown",
            ),
          );
          return { state: "delivery_unknown" as const };
        }
      },
    );
  } catch (error) {
    if (error instanceof ContentChangedError) {
      await deps.repository.transitionApprovalEnvelope(userId, approvalId, ["approved"], "failed");
      await deps.repository.deleteApprovalEnvelope(userId, approvalId);
      await deps.repository.appendAudit(
        buildAuditEvent(
          userId,
          envelope.installationId,
          envelope.accountId,
          "mail.send.dispatch",
          "blocked",
          "CONTENT_CHANGED_SINCE_APPROVAL",
          requestId,
          null,
          "denied",
        ),
      );
      throw new McpMailAccessError("CONTENT_CHANGED_SINCE_APPROVAL", 409);
    }
    await deps.repository.transitionApprovalEnvelope(userId, approvalId, ["approved"], "cancelled");
    await deps.repository.deleteApprovalEnvelope(userId, approvalId);
    await deps.repository.appendAudit(
      buildAuditEvent(
        userId,
        envelope.installationId,
        envelope.accountId,
        "mail.send.dispatch",
        "blocked",
        error instanceof McpMailAccessError ? error.code : "SEND_PRECONDITION_FAILED",
        requestId,
        null,
        "denied",
      ),
    );
    throw error;
  }
}
