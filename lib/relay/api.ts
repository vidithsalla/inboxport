import { RelayConfigurationError } from "./config.ts";
import { GoogleOAuthError } from "./google-oauth.ts";
import { MicrosoftOAuthError } from "./microsoft-oauth.ts";
import { RelayMailAccessError } from "./gmail-service.ts";
import { OutlookAccessError } from "./outlook-service.ts";
import { McpMailAccessError } from "./mcp/mail-tools-service.ts";
import { InstallationManagementError } from "./mcp/installation-service.ts";
import { GmailApiError } from "./providers/gmail.ts";
import { OutlookApiError } from "./providers/outlook.ts";

export const requestId = (): string => crypto.randomUUID();

export const jsonNoStore = (payload: unknown, init: ResponseInit = {}): Response => {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "no-store");
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  return new Response(JSON.stringify(payload), { ...init, headers });
};

export function apiError(error: unknown, id: string): Response {
  if (error instanceof RelayConfigurationError) {
    return jsonNoStore(
      { error: error.code, request_id: id, missing: error.missing },
      { status: 503 },
    );
  }
  if (error instanceof RelayMailAccessError) {
    return jsonNoStore({ error: error.code, request_id: id }, { status: error.status });
  }
  if (error instanceof OutlookAccessError) {
    return jsonNoStore({ error: error.code, request_id: id }, { status: error.status });
  }
  if (error instanceof InstallationManagementError) {
    return jsonNoStore({ error: error.code, request_id: id }, { status: error.status });
  }
  if (error instanceof McpMailAccessError) {
    return jsonNoStore({ error: error.code, request_id: id }, { status: error.status });
  }
  if (error instanceof GoogleOAuthError || error instanceof MicrosoftOAuthError) {
    return jsonNoStore({ error: error.code, request_id: id }, { status: error.status });
  }
  if (error instanceof GmailApiError || error instanceof OutlookApiError) {
    const status = error.code === "RATE_LIMITED" ? 429 : error.status >= 500 ? 502 : error.status;
    return jsonNoStore({ error: error.message, request_id: id }, { status });
  }
  return jsonNoStore({ error: "RELAY_INTERNAL_ERROR", request_id: id }, { status: 500 });
}

export function hasValidMutationOrigin(request: Request, appUrl: string): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    const requestOrigin = new URL(request.url).origin;
    const configuredOrigin = new URL(appUrl).origin;
    const submittedOrigin = new URL(origin).origin;
    return submittedOrigin === requestOrigin || submittedOrigin === configuredOrigin;
  } catch {
    return false;
  }
}

export function parsePositiveInteger(
  value: string | null,
  fallback: number,
  maximum: number,
): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

export function accountIdFromPath(request: Request): string | null {
  const match = new URL(request.url).pathname.match(/\/api\/accounts\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function resourceIdFromPath(
  request: Request,
  resource: "messages" | "threads",
): string | null {
  const match = new URL(request.url).pathname.match(
    new RegExp(`/api/mail/${resource}/([^/]+)`),
  );
  return match ? decodeURIComponent(match[1]) : null;
}
