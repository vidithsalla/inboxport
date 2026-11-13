// Bumped to 2: the hashed payload now binds the draft's real From header and
// BOTH the text/plain and text/html bodies, so a change to either alternative
// (or to From) after approval changes the hash and aborts the send.
export const SEND_ENVELOPE_VERSION = 2 as const;
export const SEND_ENVELOPE_MAX_TTL_MS = 10 * 60 * 1000;

export type CanonicalSendPayload = Readonly<{
  version: typeof SEND_ENVELOPE_VERSION;
  accountId: string;
  from: string;
  to: readonly string[];
  cc: readonly string[];
  bcc: readonly string[];
  subject: string;
  bodyText: string;
  bodyHtml: string;
  inReplyTo: string | null;
  threadId: string | null;
  attachments: readonly [];
}>;

export type SendPayloadInput = Omit<CanonicalSendPayload, "version" | "attachments"> & {
  attachments?: readonly unknown[];
};

export const SEND_STATES = [
  "proposed",
  "awaiting_approval",
  "approved",
  "dispatching",
  "sent",
  "denied",
  "expired",
  "cancelled",
  "failed",
  "delivery_unknown",
] as const;

export type SendState = (typeof SEND_STATES)[number];

const ALLOWED_TRANSITIONS: Readonly<Record<SendState, readonly SendState[]>> = {
  proposed: ["awaiting_approval", "cancelled"],
  awaiting_approval: ["approved", "denied", "expired", "cancelled"],
  approved: ["dispatching", "expired", "cancelled"],
  dispatching: ["sent", "failed", "delivery_unknown"],
  sent: [],
  denied: [],
  expired: [],
  cancelled: [],
  failed: [],
  delivery_unknown: [],
};

const normalize = (value: string): string =>
  value.normalize("NFC").replace(/\r\n?/g, "\n");

export function canonicalizeSendPayload(
  input: SendPayloadInput,
): CanonicalSendPayload {
  if (input.attachments && input.attachments.length > 0) {
    throw new Error("ATTACHMENTS_NOT_SUPPORTED_IN_MVP");
  }
  if (input.to.length + input.cc.length + input.bcc.length === 0) {
    throw new Error("SEND_RECIPIENT_REQUIRED");
  }

  return {
    version: SEND_ENVELOPE_VERSION,
    accountId: input.accountId,
    from: normalize(input.from),
    to: input.to.map(normalize),
    cc: input.cc.map(normalize),
    bcc: input.bcc.map(normalize),
    subject: normalize(input.subject),
    bodyText: normalize(input.bodyText),
    bodyHtml: normalize(input.bodyHtml),
    inReplyTo: input.inReplyTo ? normalize(input.inReplyTo) : null,
    threadId: input.threadId ? normalize(input.threadId) : null,
    attachments: [],
  };
}

export function serializeCanonicalSendPayload(
  payload: CanonicalSendPayload,
): string {
  return JSON.stringify(payload);
}

export async function hashCanonicalSendPayload(
  payload: CanonicalSendPayload,
): Promise<string> {
  const bytes = new TextEncoder().encode(serializeCanonicalSendPayload(payload));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function transitionSendState(from: SendState, to: SendState): SendState {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new Error(`SEND_TRANSITION_FORBIDDEN:${from}:${to}`);
  }
  return to;
}

export function assertEnvelopeExpiry(createdAt: Date, expiresAt: Date): void {
  const ttl = expiresAt.getTime() - createdAt.getTime();
  if (ttl <= 0 || ttl > SEND_ENVELOPE_MAX_TTL_MS) {
    throw new Error("SEND_ENVELOPE_TTL_INVALID");
  }
}
