import type { ProviderDraftInput } from "../provider-adapter.ts";

const GRAPH_API_ROOT = "https://graph.microsoft.com/v1.0";

export type OutlookProfile = Readonly<{ emailAddress: string }>;

export type OutlookSearchResult = Readonly<{
  id: string;
  /** Microsoft Graph's `conversationId`; used as this adapter's thread identifier. */
  threadId: string;
  internalDate: string | null;
  from: string | null;
  subject: string | null;
  date: string | null;
  snippet: string;
}>;

export type OutlookMessage = OutlookSearchResult & Readonly<{
  to: string | null;
  cc: string | null;
  bodyText: string;
  bodyTruncated: boolean;
}>;

export type OutlookThread = Readonly<{
  id: string;
  messages: readonly OutlookMessage[];
}>;

/**
 * A Graph draft has no separate "draft id" from "message id" the way Gmail
 * does -- a draft is just a message with isDraft: true, and sending it moves
 * (not recreates) that same resource -- so draftId and providerMessageId are
 * always identical here.
 */
export type OutlookDraftResult = Readonly<{
  draftId: string;
  providerMessageId: string;
  threadId: string | null;
}>;

export type OutlookDraftContent = Readonly<{
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

export type OutlookSendResult = Readonly<{ providerMessageId: string; threadId: string | null }>;

export class OutlookApiError extends Error {
  readonly code:
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "RATE_LIMITED"
    | "NOT_FOUND"
    | "UPSTREAM_FAILED"
    | "INVALID_RESPONSE"
    | "THREADING_REQUIRES_MESSAGE_ID";
  readonly status: number;

  constructor(
    code:
      | "UNAUTHORIZED"
      | "FORBIDDEN"
      | "RATE_LIMITED"
      | "NOT_FOUND"
      | "UPSTREAM_FAILED"
      | "INVALID_RESPONSE"
      | "THREADING_REQUIRES_MESSAGE_ID",
    status: number,
  ) {
    super(`OUTLOOK_${code}`);
    this.code = code;
    this.status = status;
  }
}

export interface OutlookProvider {
  getProfile(accessToken: string): Promise<OutlookProfile>;
  search(accessToken: string, query: string, maxResults: number): Promise<readonly OutlookSearchResult[]>;
  getMessage(accessToken: string, messageId: string, maxBytes: number): Promise<OutlookMessage>;
  getThread(
    accessToken: string,
    threadId: string,
    maxBytes: number,
    maxMessages?: number,
  ): Promise<OutlookThread>;
  createDraft(accessToken: string, draft: ProviderDraftInput): Promise<OutlookDraftResult>;
  updateDraft(
    accessToken: string,
    providerDraftId: string,
    draft: ProviderDraftInput,
  ): Promise<OutlookDraftResult>;
  getDraft(accessToken: string, providerDraftId: string): Promise<OutlookDraftContent>;
  sendDraft(accessToken: string, providerDraftId: string): Promise<OutlookSendResult>;
}

type GraphRecipient = { emailAddress?: { address?: string; name?: string } };
type GraphMessage = {
  id?: string;
  conversationId?: string;
  subject?: string;
  bodyPreview?: string;
  receivedDateTime?: string;
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  bccRecipients?: GraphRecipient[];
  body?: { contentType?: string; content?: string };
  hasAttachments?: boolean;
  /** Only present when the request asked for $expand=attachments. */
  attachments?: Array<{ id?: string }>;
};

function classifyGraphStatus(status: number): OutlookApiError["code"] {
  return status === 401
    ? "UNAUTHORIZED"
    : status === 403
      ? "FORBIDDEN"
      : status === 404
        ? "NOT_FOUND"
        : status === 429
          ? "RATE_LIMITED"
          : "UPSTREAM_FAILED";
}

/**
 * Microsoft's own documented caveat: a message's `id` is not guaranteed
 * stable when the message moves between folders -- which is exactly what
 * happens on send (Drafts -> Sent Items). Relay never persists a Graph
 * message id past the moment it reads one (the pre-send id lives only for
 * the lifetime of one approval request), but `sendDraft` below returns that
 * same pre-send id as `providerMessageId` to the caller, so it must remain
 * valid after the move. This header requests Graph's alternate, longer id
 * format that is guaranteed to stay stable across folder moves instead of
 * the default, mutable one. See https://learn.microsoft.com/graph/outlook-immutable-id
 */
const IMMUTABLE_ID_PREFER_HEADER = 'IdType="ImmutableId"';

async function graphFetch<T>(
  accessToken: string,
  path: string,
  fetcher: typeof fetch,
  init?: Readonly<{ method: "POST" | "PATCH"; body: unknown }>,
): Promise<T> {
  const response = await fetcher(`${GRAPH_API_ROOT}${path}`, {
    method: init?.method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
      prefer: IMMUTABLE_ID_PREFER_HEADER,
      ...(init ? { "content-type": "application/json" } : {}),
    },
    body: init ? JSON.stringify(init.body) : undefined,
  });
  if (!response.ok) {
    throw new OutlookApiError(classifyGraphStatus(response.status), response.status);
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new OutlookApiError("INVALID_RESPONSE", 502);
  }
}

/**
 * Graph's send-draft endpoint documents a 202 Accepted with an empty body on
 * success -- there is no JSON to parse, unlike every other Graph call this
 * adapter makes, so it needs its own fetch path rather than graphFetch<T>.
 */
async function graphFetchNoContent(
  accessToken: string,
  path: string,
  fetcher: typeof fetch,
): Promise<void> {
  const response = await fetcher(`${GRAPH_API_ROOT}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, prefer: IMMUTABLE_ID_PREFER_HEADER },
  });
  if (!response.ok) {
    throw new OutlookApiError(classifyGraphStatus(response.status), response.status);
  }
}

const formatRecipients = (recipients: GraphRecipient[] | undefined): string | null => {
  if (!recipients || recipients.length === 0) return null;
  const addresses = recipients.map((r) => r.emailAddress?.address).filter(Boolean);
  return addresses.length > 0 ? addresses.join(", ") : null;
};

function htmlToText(html: string): string {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function toSearchResult(message: GraphMessage): OutlookSearchResult {
  if (!message.id || !message.conversationId) {
    throw new OutlookApiError("INVALID_RESPONSE", 502);
  }
  return {
    id: message.id,
    threadId: message.conversationId,
    internalDate: message.receivedDateTime ?? null,
    from: message.from?.emailAddress?.address ?? null,
    subject: message.subject ?? null,
    date: message.receivedDateTime ?? null,
    snippet: message.bodyPreview ?? "",
  };
}

function toMessage(message: GraphMessage, maxBytes: number): OutlookMessage {
  const metadata = toSearchResult(message);
  const contentType = message.body?.contentType?.toLowerCase();
  const rawContent = message.body?.content ?? "";
  const unbounded = contentType === "html" ? htmlToText(rawContent) : rawContent;
  const bytes = new TextEncoder().encode(unbounded);
  const truncated = bytes.byteLength > maxBytes;
  const bodyText = truncated ? new TextDecoder().decode(bytes.slice(0, maxBytes)) : unbounded;
  return {
    ...metadata,
    to: formatRecipients(message.toRecipients),
    cc: formatRecipients(message.ccRecipients),
    bodyText,
    bodyTruncated: truncated,
  };
}

const toGraphRecipients = (addresses: readonly string[]): GraphRecipient[] =>
  addresses.map((address) => ({ emailAddress: { address } }));

/**
 * Graph messages are JSON, not raw MIME -- there is no Content-Type header
 * to get wrong the way Gmail's MIME builder could (and once did). `format`
 * maps directly to Graph's own `contentType` enum, so there is no equivalent
 * subtype-mismatch class of bug here.
 *
 * This is deliberately just the field set with no threading logic:
 * In-Reply-To/References/Message-ID are transport-managed headers Graph
 * validates and rejects on a client-supplied internetMessageHeaders array,
 * whether on create or update -- see createDraft's reply branch below for
 * how threading is actually established.
 */
function toGraphMessageFields(draft: ProviderDraftInput): Record<string, unknown> {
  return {
    subject: draft.subject,
    body: { contentType: draft.body.format === "html" ? "HTML" : "Text", content: draft.body.content },
    toRecipients: toGraphRecipients(draft.to),
    ccRecipients: toGraphRecipients(draft.cc),
    bccRecipients: toGraphRecipients(draft.bcc),
  };
}

function toDraftResult(message: GraphMessage): OutlookDraftResult {
  if (!message.id) throw new OutlookApiError("INVALID_RESPONSE", 502);
  return {
    draftId: message.id,
    providerMessageId: message.id,
    threadId: message.conversationId ?? null,
  };
}

function toDraftContent(message: GraphMessage): OutlookDraftContent {
  if (!message.id) throw new OutlookApiError("INVALID_RESPONSE", 502);
  const contentType = message.body?.contentType?.toLowerCase();
  const rawContent = message.body?.content ?? "";
  return {
    draftId: message.id,
    threadId: message.conversationId ?? null,
    from: message.from?.emailAddress?.address ?? "",
    to: formatRecipients(message.toRecipients) ?? "",
    cc: formatRecipients(message.ccRecipients) ?? "",
    bcc: formatRecipients(message.bccRecipients) ?? "",
    subject: message.subject ?? "",
    bodyText: contentType === "html" ? "" : rawContent,
    bodyHtml: contentType === "html" ? rawContent : "",
    // hasAttachments is Graph's own single self-reported flag -- Gmail's
    // equivalent check deliberately ORs three independent signals
    // (filename/attachmentId/Content-Disposition) rather than trusting one.
    // Documented Graph inconsistency (microsoftgraph/msgraph-sdk-dotnet#1683):
    // a message with ONLY inline attachments can leave hasAttachments false
    // AND the expanded attachments collection empty. A `cid:` reference in
    // the HTML body is how Outlook links inline content into the body, so it
    // survives even when neither of the other two signals fires -- a third,
    // independent signal, matching Gmail's multi-signal philosophy. Fails
    // closed (over-detecting, never under-detecting).
    hasAttachments:
      message.hasAttachments === true ||
      (message.attachments?.length ?? 0) > 0 ||
      (contentType === "html" && /cid:/i.test(rawContent)),
  };
}

export class OutlookAdapter implements OutlookProvider {
  private readonly fetcher: typeof fetch;

  constructor(fetcher: typeof fetch = fetch) {
    this.fetcher = fetcher;
  }

  async getProfile(accessToken: string): Promise<OutlookProfile> {
    const payload = await graphFetch<{ mail?: string; userPrincipalName?: string }>(
      accessToken,
      "/me?$select=mail,userPrincipalName",
      this.fetcher,
    );
    const emailAddress = payload.mail ?? payload.userPrincipalName;
    if (!emailAddress) throw new OutlookApiError("INVALID_RESPONSE", 502);
    return { emailAddress };
  }

  async search(
    accessToken: string,
    query: string,
    maxResults: number,
  ): Promise<readonly OutlookSearchResult[]> {
    const params = new URLSearchParams({
      $search: `"${query.replace(/"/g, '\\"')}"`,
      $top: String(Math.min(Math.max(maxResults, 1), 50)),
    });
    const payload = await graphFetch<{ value?: GraphMessage[] }>(
      accessToken,
      `/me/messages?${params}`,
      this.fetcher,
    );
    return (payload.value ?? []).map(toSearchResult);
  }

  async getMessage(accessToken: string, messageId: string, maxBytes: number): Promise<OutlookMessage> {
    const payload = await graphFetch<GraphMessage>(
      accessToken,
      `/me/messages/${encodeURIComponent(messageId)}`,
      this.fetcher,
    );
    return toMessage(payload, maxBytes);
  }

  async getThread(
    accessToken: string,
    threadId: string,
    maxBytes: number,
    maxMessages = 25,
  ): Promise<OutlookThread> {
    const params = new URLSearchParams({
      $filter: `conversationId eq '${threadId.replace(/'/g, "''")}'`,
      $orderby: "receivedDateTime",
      $top: String(maxMessages),
    });
    const payload = await graphFetch<{ value?: GraphMessage[] }>(
      accessToken,
      `/me/messages?${params}`,
      this.fetcher,
    );
    const messages = payload.value ?? [];
    const perMessageBudget = Math.max(1, Math.floor(maxBytes / Math.max(messages.length, 1)));
    return {
      id: threadId,
      messages: messages.map((message) => toMessage(message, perMessageBudget)),
    };
  }

  /**
   * A reply (draft.inReplyTo set) is created via Graph's dedicated
   * createReply endpoint, not a generic POST with hand-set threading
   * headers -- createReply is what actually ties the new draft to the
   * original message's conversationId. Passing the full field set as the
   * `message` override (rather than only a `comment`) replaces Graph's
   * auto-populated recipients/subject/quoted-body outright, so Relay still
   * controls the exact content that will be sent -- it just gets there
   * through createReply's override mechanism instead of avoiding the
   * endpoint. draft.threadId is not needed here: createReply derives the
   * conversation from draft.inReplyTo (the message being replied to)
   * server-side.
   *
   * Unlike Gmail (whose drafts.create accepts a bare threadId and threads
   * purely on that), Graph has no way to attach a new message to an existing
   * conversation except through createReply/createReplyAll/createForward,
   * all of which require a specific source message id -- a conversationId
   * alone is not an accepted input anywhere in Graph's message-creation API.
   * So threadId with no inReplyTo cannot be honored at all here; failing
   * loudly is safer than the alternative of silently creating a plain,
   * unthreaded draft while reporting success.
   */
  async createDraft(accessToken: string, draft: ProviderDraftInput): Promise<OutlookDraftResult> {
    if (draft.threadId && !draft.inReplyTo) {
      throw new OutlookApiError("THREADING_REQUIRES_MESSAGE_ID", 400);
    }
    const payload = draft.inReplyTo
      ? await graphFetch<GraphMessage>(
          accessToken,
          `/me/messages/${encodeURIComponent(draft.inReplyTo)}/createReply`,
          this.fetcher,
          { method: "POST", body: { message: toGraphMessageFields(draft) } },
        )
      : await graphFetch<GraphMessage>(accessToken, "/me/messages", this.fetcher, {
          method: "POST",
          body: toGraphMessageFields(draft),
        });
    return toDraftResult(payload);
  }

  async updateDraft(
    accessToken: string,
    providerDraftId: string,
    draft: ProviderDraftInput,
  ): Promise<OutlookDraftResult> {
    const payload = await graphFetch<GraphMessage>(
      accessToken,
      `/me/messages/${encodeURIComponent(providerDraftId)}`,
      this.fetcher,
      { method: "PATCH", body: toGraphMessageFields(draft) },
    );
    return toDraftResult(payload);
  }

  async getDraft(accessToken: string, providerDraftId: string): Promise<OutlookDraftContent> {
    // $expand=attachments so hasAttachments (a single self-reported flag) is
    // cross-checked against the actual attachments collection in the same
    // request, rather than trusted alone -- see toDraftContent.
    const payload = await graphFetch<GraphMessage>(
      accessToken,
      `/me/messages/${encodeURIComponent(providerDraftId)}?$expand=attachments`,
      this.fetcher,
    );
    return toDraftContent(payload);
  }

  async sendDraft(accessToken: string, providerDraftId: string): Promise<OutlookSendResult> {
    await graphFetchNoContent(
      accessToken,
      `/me/messages/${encodeURIComponent(providerDraftId)}/send`,
      this.fetcher,
    );
    // Graph's send-draft response has no body (see graphFetchNoContent): the
    // draft's own id is retained through send (Graph moves the resource
    // rather than recreating it), and conversationId isn't available here --
    // the caller already read it moments earlier via getDraft while building
    // the approval hash.
    return { providerMessageId: providerDraftId, threadId: null };
  }
}
