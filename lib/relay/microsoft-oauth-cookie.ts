import {
  type EnvelopeVault,
  decodeOpaque,
  encodeOpaque,
  parseEnvelope,
  serializeEnvelope,
} from "./crypto.ts";

export const MICROSOFT_OAUTH_COOKIE = "relay_microsoft_oauth";
export const MICROSOFT_OAUTH_TTL_SECONDS = 10 * 60;

export type MicrosoftOAuthTransaction = Readonly<{
  state: string;
  codeVerifier: string;
  userId: string;
  returnTo: string;
  createdAt: string;
  scopeUpgrade: "compose" | null;
}>;

const COOKIE_CONTEXT = "relay-mail:microsoft-oauth-cookie:v1";

export async function sealMicrosoftOAuthCookie(
  vault: EnvelopeVault,
  transaction: MicrosoftOAuthTransaction,
): Promise<string> {
  const envelope = await vault.seal(JSON.stringify(transaction), COOKIE_CONTEXT);
  return encodeOpaque(serializeEnvelope(envelope));
}

export async function openMicrosoftOAuthCookie(
  vault: EnvelopeVault,
  value: string,
): Promise<MicrosoftOAuthTransaction> {
  const plaintext = await vault.open(parseEnvelope(decodeOpaque(value)), COOKIE_CONTEXT);
  const parsed = JSON.parse(plaintext) as Partial<MicrosoftOAuthTransaction>;
  if (
    typeof parsed.state !== "string" ||
    typeof parsed.codeVerifier !== "string" ||
    typeof parsed.userId !== "string" ||
    typeof parsed.returnTo !== "string" ||
    typeof parsed.createdAt !== "string" ||
    (parsed.scopeUpgrade !== undefined && parsed.scopeUpgrade !== null && parsed.scopeUpgrade !== "compose")
  ) {
    throw new Error("MICROSOFT_OAUTH_TRANSACTION_INVALID");
  }
  return { ...parsed, scopeUpgrade: parsed.scopeUpgrade ?? null } as MicrosoftOAuthTransaction;
}

export function createMicrosoftOAuthCookieHeader(value: string, secure: boolean): string {
  return [
    `${MICROSOFT_OAUTH_COOKIE}=${value}`,
    `Max-Age=${MICROSOFT_OAUTH_TTL_SECONDS}`,
    "Path=/api/oauth/microsoft/callback",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

export function clearMicrosoftOAuthCookieHeader(secure: boolean): string {
  return [
    `${MICROSOFT_OAUTH_COOKIE}=`,
    "Max-Age=0",
    "Path=/api/oauth/microsoft/callback",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
}
