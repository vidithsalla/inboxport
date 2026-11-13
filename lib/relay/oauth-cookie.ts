import {
  type EnvelopeVault,
  decodeOpaque,
  encodeOpaque,
  parseEnvelope,
  serializeEnvelope,
} from "./crypto.ts";

export const GOOGLE_OAUTH_COOKIE = "relay_google_oauth";
export const GOOGLE_OAUTH_TTL_SECONDS = 10 * 60;

export type GoogleOAuthTransaction = Readonly<{
  state: string;
  codeVerifier: string;
  userId: string;
  returnTo: string;
  createdAt: string;
  scopeUpgrade: "compose" | null;
}>;

const COOKIE_CONTEXT = "relay-mail:google-oauth-cookie:v1";

export async function sealGoogleOAuthCookie(
  vault: EnvelopeVault,
  transaction: GoogleOAuthTransaction,
): Promise<string> {
  const envelope = await vault.seal(JSON.stringify(transaction), COOKIE_CONTEXT);
  return encodeOpaque(serializeEnvelope(envelope));
}

export async function openGoogleOAuthCookie(
  vault: EnvelopeVault,
  value: string,
): Promise<GoogleOAuthTransaction> {
  const plaintext = await vault.open(parseEnvelope(decodeOpaque(value)), COOKIE_CONTEXT);
  const parsed = JSON.parse(plaintext) as Partial<GoogleOAuthTransaction>;
  if (
    typeof parsed.state !== "string" ||
    typeof parsed.codeVerifier !== "string" ||
    typeof parsed.userId !== "string" ||
    typeof parsed.returnTo !== "string" ||
    typeof parsed.createdAt !== "string" ||
    (parsed.scopeUpgrade !== undefined && parsed.scopeUpgrade !== null && parsed.scopeUpgrade !== "compose")
  ) {
    throw new Error("GOOGLE_OAUTH_TRANSACTION_INVALID");
  }
  return { ...parsed, scopeUpgrade: parsed.scopeUpgrade ?? null } as GoogleOAuthTransaction;
}

export function readCookie(request: Request, name: string): string | null {
  const cookies = request.headers.get("cookie") ?? "";
  for (const part of cookies.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

export function createOAuthCookieHeader(
  value: string,
  secure: boolean,
): string {
  return [
    `${GOOGLE_OAUTH_COOKIE}=${value}`,
    `Max-Age=${GOOGLE_OAUTH_TTL_SECONDS}`,
    "Path=/api/oauth/google/callback",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

export function clearOAuthCookieHeader(secure: boolean): string {
  return [
    `${GOOGLE_OAUTH_COOKIE}=`,
    "Max-Age=0",
    "Path=/api/oauth/google/callback",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

export function safeReturnTo(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const url = new URL(value, "https://relay.invalid");
    return url.origin === "https://relay.invalid"
      ? `${url.pathname}${url.search}${url.hash}`
      : "/";
  } catch {
    return "/";
  }
}
