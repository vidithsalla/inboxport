import { encodeOpaque } from "../crypto.ts";
import type { ProviderDraftInput } from "../provider-adapter.ts";

const GMAIL_API_ROOT = "https://gmail.googleapis.com/gmail/v1/users/me";

export type GmailProfile = Readonly<{
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
  historyId: string;
}>;

export type MailHeader = Readonly<{ name: string; value: string }>;

export type GmailSearchResult = Readonly<{
  id: string;
  threadId: string;
  internalDate: string | null;
  from: string | null;
  subject: string | null;
  date: string | null;
  snippet: string;
  labelIds: readonly string[];
}>;

export type GmailMessage = GmailSearchResult & Readonly<{
  to: string | null;
  cc: string | null;
  bodyText: string;
  bodyTruncated: boolean;
}>;

export type GmailThread = Readonly<{
  id: string;
  historyId: string | null;
  messages: readonly GmailMessage[];
}>;

type GmailMessagePart = {
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailMessagePart[];
};

type GmailMessagePayload = {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailMessagePart;
};

export class GmailApiError extends Error {
  readonly code: "UNAUTHORIZED" | "FORBIDDEN" | "RATE_LIMITED" | "NOT_FOUND" | "UPSTREAM_FAILED" | "INVALID_RESPONSE";
  readonly status: number;

  constructor(
    code: "UNAUTHORIZED" | "FORBIDDEN" | "RATE_LIMITED" | "NOT_FOUND" | "UPSTREAM_FAILED" | "INVALID_RESPONSE",
    status: number,
  ) {
    super(`GMAIL_${code}`);
    this.code = code;
    this.status = status;
  }
}

export type GmailDraftResult = Readonly<{
  draftId: string;
  providerMessageId: string;
  threadId: string | null;
}>;

/**
 * The current, exact content of a provider-side draft as Gmail would send
 * it right now. Recipient headers are kept as Gmail's own joined header
 * string (not split into individual addresses) so a re-fetch can be
 * compared byte-for-byte against an earlier fetch without a fragile
 * RFC 5322 address-list parser.
 */
export type GmailDraftContent = Readonly<{
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

export type GmailSendResult = Readonly<{ providerMessageId: string; threadId: string | null }>;

export type GmailWatchResult = Readonly<{ historyId: string; expiration: string }>;

export type GmailHistoryPage = Readonly<{
  historyId: string;
  recordCount: number;
  nextPageToken: string | null;
}>;

export const GMAIL_SUBJECT_HASH_CONTEXT = "relay-mail:gmail-subject:v1";

export interface GmailProvider {
  getProfile(accessToken: string): Promise<GmailProfile>;
  search(accessToken: string, query: string, maxResults: number): Promise<readonly GmailSearchResult[]>;
  getMessage(accessToken: string, messageId: string, maxBytes: number): Promise<GmailMessage>;
  getThread(
    accessToken: string,
    threadId: string,
    maxBytes: number,
    maxMessages?: number,
  ): Promise<GmailThread>;
  createDraft(accessToken: string, draft: ProviderDraftInput): Promise<GmailDraftResult>;
  updateDraft(
    accessToken: string,
    providerDraftId: string,
    draft: ProviderDraftInput,
  ): Promise<GmailDraftResult>;
  getDraft(accessToken: string, providerDraftId: string): Promise<GmailDraftContent>;
  sendDraft(accessToken: string, providerDraftId: string): Promise<GmailSendResult>;
  watch(accessToken: string, topicName: string): Promise<GmailWatchResult>;
  stopWatch(accessToken: string): Promise<void>;
  historyList(
    accessToken: string,
    startHistoryId: string,
    pageToken?: string,
  ): Promise<GmailHistoryPage>;
}

async function gmailFetch<T>(
  accessToken: string,
  path: string,
  fetcher: typeof fetch,
  init?: Readonly<{ method: "POST" | "PUT"; body: unknown }>,
): Promise<T> {
  const response = await fetcher(`${GMAIL_API_ROOT}${path}`, {
    method: init?.method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
      ...(init ? { "content-type": "application/json" } : {}),
    },
    body: init ? JSON.stringify(init.body) : undefined,
  });
  if (!response.ok) {
    const code = response.status === 401
      ? "UNAUTHORIZED"
      : response.status === 403
        ? "FORBIDDEN"
        : response.status === 404
          ? "NOT_FOUND"
          : response.status === 429
            ? "RATE_LIMITED"
            : "UPSTREAM_FAILED";
    throw new GmailApiError(code, response.status);
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new GmailApiError("INVALID_RESPONSE", 502);
  }
}

const findHeader = (part: GmailMessagePart | undefined, name: string): string | null => {
  const header = part?.headers?.find(
    (candidate) => candidate.name?.toLowerCase() === name.toLowerCase(),
  );
  return header?.value ?? null;
};

const decodeBase64Url = (value: string): string => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  );
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
};

const htmlToText = (html: string): string => html
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

/**
 * Fetches a MIME part's body bytes when Gmail didn't inline them. Gmail omits
 * `body.data` and sets `body.attachmentId` instead whenever a part's content
 * was too large for the response -- true for an oversized text/plain or
 * text/html BODY part, not only for real attachments (see isAttachmentPart).
 * Without this fetch, collectBodies would silently drop that text with no
 * truncation flag, and -- since getDraft's send-approval hash is built from
 * exactly what collectBodies returns -- a human could approve a draft based
 * on incomplete content while Gmail actually sends the full thing. A fetch
 * failure here throws rather than degrading to a truncated read, since
 * silently returning incomplete content is the exact failure mode this
 * exists to close.
 */
async function fetchAttachmentData(
  accessToken: string,
  messageId: string,
  attachmentId: string,
  fetcher: typeof fetch,
): Promise<string> {
  const attachment = await gmailFetch<{ data?: string }>(
    accessToken,
    `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    fetcher,
  );
  if (!attachment.data) throw new GmailApiError("INVALID_RESPONSE", 502);
  return attachment.data;
}

async function collectBodies(
  part: GmailMessagePart | undefined,
  messageId: string,
  accessToken: string,
  fetcher: typeof fetch,
): Promise<{ plain: string[]; html: string[] }> {
  const collected = { plain: [] as string[], html: [] as string[] };
  const visit = async (candidate: GmailMessagePart | undefined): Promise<void> => {
    if (!candidate) return;
    const mimeType = candidate.mimeType?.toLowerCase();
    if (mimeType === "text/plain" || mimeType === "text/html") {
      const data =
        candidate.body?.data ??
        (candidate.body?.attachmentId
          ? await fetchAttachmentData(accessToken, messageId, candidate.body.attachmentId, fetcher)
          : undefined);
      if (data) {
        const decoded = decodeBase64Url(data);
        if (mimeType === "text/plain") collected.plain.push(decoded);
        else collected.html.push(decoded);
      }
    }
    for (const nested of candidate.parts ?? []) await visit(nested);
  };
  await visit(part);
  return collected;
}

/**
 * A MIME part is treated as an attachment if it has a filename, carries a
 * separate attachment body (`attachmentId`), or is explicitly dispositioned
 * as an attachment. Filename alone is insufficient -- inline images and some
 * attachment-backed parts omit it -- so all three signals are checked.
 *
 * `attachmentId` alone is a weaker signal than it looks: Gmail sets it
 * whenever a part's bytes were too large to inline in the response, which
 * applies just as much to an oversized text/plain or text/html BODY part
 * (a long plaintext digest, an HTML mail with a large embedded image) as to
 * a genuine attachment. Trusting it unconditionally would misclassify that
 * body part as an attachment -- collectBodies would silently drop its text
 * (only `body.data` is read there), and hasAttachmentParts would wrongly
 * trip the MVP's ATTACHMENTS_NOT_SUPPORTED_IN_MVP send-approval guard for a
 * message that never had a real attachment. So attachmentId only counts
 * here when the part's MIME type isn't one of the two body types.
 */
function isAttachmentPart(part: GmailMessagePart): boolean {
  if (part.filename && part.filename.length > 0) return true;
  const disposition = part.headers
    ?.find((header) => header.name?.toLowerCase() === "content-disposition")
    ?.value?.toLowerCase();
  if (disposition?.includes("attachment") === true) return true;
  const mimeType = part.mimeType?.toLowerCase();
  return part.body?.attachmentId !== undefined && mimeType !== "text/plain" && mimeType !== "text/html";
}

function hasAttachmentParts(part: GmailMessagePart | undefined): boolean {
  if (!part) return false;
  if (isAttachmentPart(part)) return true;
  return (part.parts ?? []).some(hasAttachmentParts);
}

function toSearchResult(message: GmailMessagePayload): GmailSearchResult {
  if (!message.id || !message.threadId) {
    throw new GmailApiError("INVALID_RESPONSE", 502);
  }
  return {
    id: message.id,
    threadId: message.threadId,
    internalDate: message.internalDate ?? null,
    from: findHeader(message.payload, "From"),
    subject: findHeader(message.payload, "Subject"),
    date: findHeader(message.payload, "Date"),
    snippet: message.snippet ?? "",
    labelIds: message.labelIds ?? [],
  };
}

async function toMessage(
  message: GmailMessagePayload,
  maxBytes: number,
  accessToken: string,
  fetcher: typeof fetch,
): Promise<GmailMessage> {
  const metadata = toSearchResult(message);
  const bodies = await collectBodies(message.payload, metadata.id, accessToken, fetcher);
  const unbounded = bodies.plain.join("\n\n") || htmlToText(bodies.html.join("\n\n"));
  const bytes = new TextEncoder().encode(unbounded);
  const truncated = bytes.byteLength > maxBytes;
  const bodyText = truncated
    ? new TextDecoder().decode(bytes.slice(0, maxBytes))
    : unbounded;
  return {
    ...metadata,
    to: findHeader(message.payload, "To"),
    cc: findHeader(message.payload, "Cc"),
    bodyText,
    bodyTruncated: truncated,
  };
}

const encodeHeaderValue = (value: string): string =>
  /^[\x00-\x7F]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf-8").toString("base64")}?=`;

/**
 * Relay's body format is `text | html`; the MIME subtype is `plain | html`.
 * These differ for `text` only, which is exactly why the mismatch survived:
 * `text/html` happens to be correct, so HTML drafts always rendered while
 * plaintext drafts silently became `text/text`. That is not a registered
 * media type, so Gmail cannot display it inline -- it degrades the part to an
 * unnamed attachment ("noname") and the draft shows no body at all. Map the
 * subtype explicitly rather than interpolating the format name.
 */
const MIME_SUBTYPE: Readonly<Record<ProviderDraftInput["body"]["format"], string>> = {
  text: "plain",
  html: "html",
};

function buildMimeMessage(draft: ProviderDraftInput): string {
  const headers: string[] = [];
  if (draft.to.length > 0) headers.push(`To: ${draft.to.join(", ")}`);
  if (draft.cc.length > 0) headers.push(`Cc: ${draft.cc.join(", ")}`);
  if (draft.bcc.length > 0) headers.push(`Bcc: ${draft.bcc.join(", ")}`);
  headers.push(`Subject: ${encodeHeaderValue(draft.subject)}`);
  if (draft.inReplyTo) {
    headers.push(`In-Reply-To: ${draft.inReplyTo}`);
    headers.push(`References: ${draft.inReplyTo}`);
  }
  headers.push("MIME-Version: 1.0");
  headers.push(`Content-Type: text/${MIME_SUBTYPE[draft.body.format]}; charset="UTF-8"`);
  headers.push("Content-Transfer-Encoding: base64");

  // RFC 2045 folds base64 at <=76 characters with CRLF. A bare LF here is not a
  // MIME line break, so the body must fold with the same CRLF the headers use.
  const encodedBody = Buffer.from(draft.body.content, "utf-8")
    .toString("base64")
    .replace(/(.{76})/g, "$1\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${encodedBody}`;
}

function toDraftResult(payload: {
  id?: string;
  message?: { id?: string; threadId?: string };
}): GmailDraftResult {
  if (!payload.id || !payload.message?.id) {
    throw new GmailApiError("INVALID_RESPONSE", 502);
  }
  return {
    draftId: payload.id,
    providerMessageId: payload.message.id,
    threadId: payload.message.threadId ?? null,
  };
}

export class GmailAdapter implements GmailProvider {
  private readonly fetcher: typeof fetch;

  constructor(fetcher: typeof fetch = fetch) {
    this.fetcher = fetcher;
  }

  getProfile(accessToken: string): Promise<GmailProfile> {
    return gmailFetch<GmailProfile>(accessToken, "/profile", this.fetcher);
  }

  async search(
    accessToken: string,
    query: string,
    maxResults: number,
  ): Promise<readonly GmailSearchResult[]> {
    const params = new URLSearchParams({
      q: query,
      maxResults: String(Math.min(Math.max(maxResults, 1), 50)),
    });
    const listing = await gmailFetch<{
      messages?: Array<{ id?: string; threadId?: string }>;
    }>(accessToken, `/messages?${params}`, this.fetcher);

    return Promise.all(
      (listing.messages ?? []).map(({ id }) => {
        if (!id) throw new GmailApiError("INVALID_RESPONSE", 502);
        const metadata = new URLSearchParams({ format: "metadata" });
        for (const header of ["From", "Subject", "Date"]) {
          metadata.append("metadataHeaders", header);
        }
        return gmailFetch<GmailMessagePayload>(
          accessToken,
          `/messages/${encodeURIComponent(id)}?${metadata}`,
          this.fetcher,
        ).then(toSearchResult);
      }),
    );
  }

  async getMessage(
    accessToken: string,
    messageId: string,
    maxBytes: number,
  ): Promise<GmailMessage> {
    const payload = await gmailFetch<GmailMessagePayload>(
      accessToken,
      `/messages/${encodeURIComponent(messageId)}?format=full`,
      this.fetcher,
    );
    return toMessage(payload, maxBytes, accessToken, this.fetcher);
  }

  async getThread(
    accessToken: string,
    threadId: string,
    maxBytes: number,
    maxMessages = 25,
  ): Promise<GmailThread> {
    const payload = await gmailFetch<{
      id?: string;
      historyId?: string;
      messages?: GmailMessagePayload[];
    }>(
      accessToken,
      `/threads/${encodeURIComponent(threadId)}?format=full`,
      this.fetcher,
    );
    if (!payload.id) throw new GmailApiError("INVALID_RESPONSE", 502);
    const messages = (payload.messages ?? []).slice(0, maxMessages);
    const perMessageBudget = Math.max(1, Math.floor(maxBytes / Math.max(messages.length, 1)));
    return {
      id: payload.id,
      historyId: payload.historyId ?? null,
      messages: await Promise.all(
        messages.map((message) => toMessage(message, perMessageBudget, accessToken, this.fetcher)),
      ),
    };
  }

  async createDraft(accessToken: string, draft: ProviderDraftInput): Promise<GmailDraftResult> {
    const raw = encodeOpaque(buildMimeMessage(draft));
    const payload = await gmailFetch<{ id?: string; message?: { id?: string; threadId?: string } }>(
      accessToken,
      "/drafts",
      this.fetcher,
      {
        method: "POST",
        body: { message: { raw, threadId: draft.threadId } },
      },
    );
    return toDraftResult(payload);
  }

  async updateDraft(
    accessToken: string,
    providerDraftId: string,
    draft: ProviderDraftInput,
  ): Promise<GmailDraftResult> {
    const raw = encodeOpaque(buildMimeMessage(draft));
    const payload = await gmailFetch<{ id?: string; message?: { id?: string; threadId?: string } }>(
      accessToken,
      `/drafts/${encodeURIComponent(providerDraftId)}`,
      this.fetcher,
      {
        method: "PUT",
        body: { message: { raw, threadId: draft.threadId } },
      },
    );
    return toDraftResult(payload);
  }

  async getDraft(accessToken: string, providerDraftId: string): Promise<GmailDraftContent> {
    const payload = await gmailFetch<{
      id?: string;
      message?: { id?: string; threadId?: string; payload?: GmailMessagePart };
    }>(accessToken, `/drafts/${encodeURIComponent(providerDraftId)}?format=full`, this.fetcher);
    if (!payload.id || !payload.message?.id) {
      throw new GmailApiError("INVALID_RESPONSE", 502);
    }
    const part = payload.message.payload;
    const bodies = await collectBodies(part, payload.message.id, accessToken, this.fetcher);
    return {
      draftId: payload.id,
      threadId: payload.message.threadId ?? null,
      from: findHeader(part, "From") ?? "",
      to: findHeader(part, "To") ?? "",
      cc: findHeader(part, "Cc") ?? "",
      bcc: findHeader(part, "Bcc") ?? "",
      subject: findHeader(part, "Subject") ?? "",
      bodyText: bodies.plain.join("\n\n"),
      bodyHtml: bodies.html.join("\n\n"),
      hasAttachments: hasAttachmentParts(part),
    };
  }

  async sendDraft(accessToken: string, providerDraftId: string): Promise<GmailSendResult> {
    const payload = await gmailFetch<{ id?: string; threadId?: string }>(
      accessToken,
      "/drafts/send",
      this.fetcher,
      { method: "POST", body: { id: providerDraftId } },
    );
    if (!payload.id) throw new GmailApiError("INVALID_RESPONSE", 502);
    return { providerMessageId: payload.id, threadId: payload.threadId ?? null };
  }

  async watch(accessToken: string, topicName: string): Promise<GmailWatchResult> {
    const payload = await gmailFetch<{ historyId?: string; expiration?: string }>(
      accessToken,
      "/watch",
      this.fetcher,
      {
        method: "POST",
        body: { topicName, labelIds: ["INBOX"], labelFilterBehavior: "INCLUDE" },
      },
    );
    if (!payload.historyId || !payload.expiration) {
      throw new GmailApiError("INVALID_RESPONSE", 502);
    }
    return { historyId: payload.historyId, expiration: payload.expiration };
  }

  async stopWatch(accessToken: string): Promise<void> {
    await gmailFetch<unknown>(accessToken, "/stop", this.fetcher, { method: "POST", body: {} });
  }

  async historyList(
    accessToken: string,
    startHistoryId: string,
    pageToken?: string,
  ): Promise<GmailHistoryPage> {
    const params = new URLSearchParams({ startHistoryId });
    if (pageToken) params.set("pageToken", pageToken);
    const payload = await gmailFetch<{
      history?: unknown[];
      historyId?: string;
      nextPageToken?: string;
    }>(accessToken, `/history?${params}`, this.fetcher);
    if (!payload.historyId) throw new GmailApiError("INVALID_RESPONSE", 502);
    return {
      historyId: payload.historyId,
      recordCount: payload.history?.length ?? 0,
      nextPageToken: payload.nextPageToken ?? null,
    };
  }
}
