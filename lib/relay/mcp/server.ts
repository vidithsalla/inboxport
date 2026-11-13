import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ensureDevelopmentSchema } from "../../../db/bootstrap.ts";
import { getDb } from "../../../db/index.ts";
import { requestId as newRequestId } from "../api.ts";
import { getRuntimeConfig, requireVaultConfig } from "../config.ts";
import { LocalEnvelopeVault } from "../crypto.ts";
import { LibsqlRelayRepository } from "../libsql-repository.ts";
import { noHeaderInjection } from "../provider-adapter.ts";
import { GmailApiError, GmailAdapter } from "../providers/gmail.ts";
import { OutlookApiError, OutlookAdapter } from "../providers/outlook.ts";
import { deriveRelayUserId } from "../request-user.ts";
import { requestSendApproval } from "../send-approval-service.ts";
import { recordInstallationContact } from "./installation-service.ts";
import {
  McpMailAccessError,
  mcpCreateDraft,
  mcpGetMessage,
  mcpGetThread,
  mcpListGrantedAccounts,
  mcpSearch,
  mcpSearchMany,
  mcpUpdateDraft,
  type McpToolDependencies,
} from "./mail-tools-service.ts";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * Built once per MCP request/session and shared by every tool call within it.
 * Only the vault key is required up front -- a Microsoft-only deployment
 * (no Google credentials configured at all) can still serve every MCP tool
 * for its Outlook accounts; Google/Microsoft credentials are each checked
 * lazily, only when an operation actually needs that specific provider's
 * token (see refreshAccessToken in mail-tools-service.ts).
 */
export async function buildMcpDependencies(): Promise<McpToolDependencies> {
  const config = requireVaultConfig(getRuntimeConfig());
  await ensureDevelopmentSchema(config.autoMigrate);
  const repository = new LibsqlRelayRepository(await getDb());
  const vault = await LocalEnvelopeVault.fromEncodedKey(config.vaultKek);
  return {
    repository,
    vault,
    config,
    adapters: { gmail: new GmailAdapter(), outlook: new OutlookAdapter() },
  };
}

function textResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function errorResult(code: string) {
  return { isError: true as const, content: [{ type: "text" as const, text: code }] };
}

function toErrorCode(error: unknown): string {
  if (
    error instanceof McpMailAccessError ||
    error instanceof GmailApiError ||
    error instanceof OutlookApiError
  ) {
    return error.message;
  }
  return "RELAY_INTERNAL_ERROR";
}

/**
 * Resolves the caller from the OAuth token's verified claims and records
 * installation contact. Every tool call re-reads installation/grant state
 * from the repository, so a revoke/pause from the console takes effect on
 * the very next call with no caching to invalidate.
 */
async function resolveCaller(
  deps: McpToolDependencies,
  extra: Extra,
  requestId: string,
): Promise<Readonly<{ userId: string; installationId: string; clientId: string }>> {
  const authInfo = extra.authInfo;
  const clerkUserId = authInfo?.extra?.userId;
  const clientId = authInfo?.clientId;
  if (typeof clerkUserId !== "string" || !clientId) {
    throw new McpMailAccessError("AUTHENTICATION_REQUIRED", 401);
  }
  const userId = await deriveRelayUserId(clerkUserId);
  const installation = await recordInstallationContact(
    deps.repository,
    userId,
    clientId,
    null,
    requestId,
  );
  if (installation.revoked) {
    throw new McpMailAccessError("GLOBAL_PAUSE", 403);
  }
  return { userId, installationId: installation.id, clientId };
}

export function registerRelayMailTools(server: McpServer, deps: McpToolDependencies): void {
  server.registerTool(
    "list_granted_accounts",
    {
      title: "List granted mail accounts",
      description:
        "Lists the Gmail and Outlook accounts this connected client has been explicitly granted read access to. Call this first to discover valid account_id values.",
      inputSchema: {},
    },
    async (_args: Record<string, never>, extra: Extra) => {
      const requestId = newRequestId();
      try {
        const { userId, installationId } = await resolveCaller(deps, extra, requestId);
        const accounts = await mcpListGrantedAccounts(deps, userId, installationId);
        return textResult({ accounts });
      } catch (error) {
        return errorResult(toErrorCode(error));
      }
    },
  );

  server.registerTool(
    "mail_search",
    {
      title: "Search a mail account",
      description:
        "Searches one explicitly named, granted Gmail or Outlook account using that provider's own search syntax (Gmail search operators, or Microsoft Graph $search for Outlook). Returns bounded metadata (from/subject/date), never full bodies. The body snippet is included only if this client also holds the read_body grant for that account; otherwise it comes back empty.",
      inputSchema: {
        account_id: z.string().min(1).describe("An account_id from list_granted_accounts"),
        query: z.string().min(1).max(512).describe("Search query, in the granted account's own provider syntax"),
        max_results: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ account_id, query, max_results }, extra: Extra) => {
      const requestId = newRequestId();
      try {
        const { userId, installationId, clientId } = await resolveCaller(deps, extra, requestId);
        const results = await mcpSearch(
          deps,
          userId,
          installationId,
          clientId,
          account_id,
          query,
          max_results ?? 20,
          requestId,
        );
        return textResult({ account_id, results });
      } catch (error) {
        return errorResult(toErrorCode(error));
      }
    },
  );

  server.registerTool(
    "mail_search_many",
    {
      title: "Search multiple mail accounts",
      description:
        "Searches up to five explicitly named, granted Gmail or Outlook accounts in one call, each in its own provider's search syntax. Each account is authorized independently; one denied or failed account never blocks the others. Snippet visibility is decided per account by that account's own read_body grant.",
      inputSchema: {
        account_ids: z.array(z.string().min(1)).min(1).max(5),
        query: z.string().min(1).max(512),
        max_results: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ account_ids, query, max_results }, extra: Extra) => {
      const requestId = newRequestId();
      try {
        const { userId, installationId, clientId } = await resolveCaller(deps, extra, requestId);
        const perAccount = await mcpSearchMany(
          deps,
          userId,
          installationId,
          clientId,
          account_ids,
          query,
          max_results ?? 20,
          requestId,
        );
        return textResult({ accounts: perAccount });
      } catch (error) {
        return errorResult(toErrorCode(error));
      }
    },
  );

  server.registerTool(
    "mail_message_get",
    {
      title: "Get a mail message",
      description: "Retrieves one message's bounded plaintext body from one explicitly named, granted account.",
      inputSchema: {
        account_id: z.string().min(1),
        message_id: z.string().min(1),
      },
    },
    async ({ account_id, message_id }, extra: Extra) => {
      const requestId = newRequestId();
      try {
        const { userId, installationId, clientId } = await resolveCaller(deps, extra, requestId);
        const message = await mcpGetMessage(
          deps,
          userId,
          installationId,
          clientId,
          account_id,
          message_id,
          requestId,
        );
        return textResult({ account_id, message });
      } catch (error) {
        return errorResult(toErrorCode(error));
      }
    },
  );

  server.registerTool(
    "mail_thread_get",
    {
      title: "Get a mail thread",
      description: "Retrieves one thread's bounded plaintext messages from one explicitly named, granted account.",
      inputSchema: {
        account_id: z.string().min(1),
        thread_id: z.string().min(1),
      },
    },
    async ({ account_id, thread_id }, extra: Extra) => {
      const requestId = newRequestId();
      try {
        const { userId, installationId, clientId } = await resolveCaller(deps, extra, requestId);
        const thread = await mcpGetThread(
          deps,
          userId,
          installationId,
          clientId,
          account_id,
          thread_id,
          requestId,
        );
        return textResult({ account_id, thread });
      } catch (error) {
        return errorResult(toErrorCode(error));
      }
    },
  );

  const draftInputShape = {
    account_id: z.string().min(1),
    to: z.array(noHeaderInjection(z.string().min(1))).default([]),
    cc: z.array(noHeaderInjection(z.string().min(1))).default([]),
    bcc: z.array(noHeaderInjection(z.string().min(1))).default([]),
    subject: noHeaderInjection(z.string().max(998)),
    body_format: z.enum(["text", "html"]).default("text"),
    body: z.string().max(200_000),
    in_reply_to: noHeaderInjection(z.string()).optional(),
    thread_id: z.string().optional(),
  };

  server.registerTool(
    "mail_draft_create",
    {
      title: "Create a mail draft",
      description:
        "Creates a provider-side draft in one explicitly named, granted Gmail or Outlook account. The draft is never persisted by InboxPort; it lives only in the user's own drafts folder until they send it themselves. This tool never sends mail. To thread as a reply, set in_reply_to to the specific message being replied to. Outlook requires in_reply_to to thread at all -- supplying thread_id alone is rejected, since Microsoft Graph has no way to attach a new message to an existing conversation without a specific source message id. Gmail accepts thread_id alone.",
      inputSchema: draftInputShape,
    },
    async ({ account_id, to, cc, bcc, subject, body_format, body, in_reply_to, thread_id }, extra: Extra) => {
      const requestId = newRequestId();
      try {
        const { userId, installationId, clientId } = await resolveCaller(deps, extra, requestId);
        const result = await mcpCreateDraft(
          deps,
          userId,
          installationId,
          clientId,
          account_id,
          {
            to,
            cc,
            bcc,
            subject,
            body: { format: body_format, content: body },
            inReplyTo: in_reply_to,
            threadId: thread_id,
          },
          requestId,
        );
        return textResult({ account_id, draft: result });
      } catch (error) {
        return errorResult(toErrorCode(error));
      }
    },
  );

  server.registerTool(
    "mail_draft_update",
    {
      title: "Update a mail draft",
      description:
        "Replaces the content of an existing provider-side draft on this granted account, identified by draft_id. Draft provenance is not currently tracked or enforced -- this can target any draft in the account, not only ones this installation created. in_reply_to and thread_id have no effect here on either provider -- a draft's threading is fixed when it is created and cannot be changed by a later update. This tool never sends mail.",
      inputSchema: { ...draftInputShape, draft_id: z.string().min(1) },
    },
    async (
      { account_id, draft_id, to, cc, bcc, subject, body_format, body, in_reply_to, thread_id },
      extra: Extra,
    ) => {
      const requestId = newRequestId();
      try {
        const { userId, installationId, clientId } = await resolveCaller(deps, extra, requestId);
        const result = await mcpUpdateDraft(
          deps,
          userId,
          installationId,
          clientId,
          account_id,
          draft_id,
          {
            to,
            cc,
            bcc,
            subject,
            body: { format: body_format, content: body },
            inReplyTo: in_reply_to,
            threadId: thread_id,
          },
          requestId,
        );
        return textResult({ account_id, draft: result });
      } catch (error) {
        return errorResult(toErrorCode(error));
      }
    },
  );

  server.registerTool(
    "mail_send_request_approval",
    {
      title: "Request approval to send a mail draft",
      description:
        "Requests human approval to send an existing provider-side draft, exactly as it currently reads. This tool never sends mail and there is no tool that can approve a send -- only the InboxPort user, from the InboxPort web console, can approve or deny it. The response includes a console_url linking directly to this specific pending approval. The request expires in 10 minutes if not resolved.",
      inputSchema: {
        account_id: z.string().min(1),
        draft_id: z.string().min(1),
      },
    },
    async ({ account_id, draft_id }, extra: Extra) => {
      const requestId = newRequestId();
      try {
        const { userId, installationId, clientId } = await resolveCaller(deps, extra, requestId);
        const summary = await requestSendApproval(
          deps,
          userId,
          installationId,
          clientId,
          account_id,
          draft_id,
          requestId,
        );
        return textResult({
          account_id,
          approval_id: summary.approvalId,
          expires_at: summary.expiresAt,
          preview: summary.preview,
          console_url: summary.consoleUrl,
          note: "Ask the InboxPort user to open console_url and approve this exact content before it can be sent.",
        });
      } catch (error) {
        return errorResult(toErrorCode(error));
      }
    },
  );
}
