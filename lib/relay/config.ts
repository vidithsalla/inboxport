export const RELAY_MAIL_NAME = "InboxPort";
export const RELAY_SUPPORT_EMAIL = "support@example.com";
export const GMAIL_READONLY_SCOPE =
  "https://www.googleapis.com/auth/gmail.readonly";
export const GMAIL_COMPOSE_SCOPE =
  "https://www.googleapis.com/auth/gmail.compose";
/** Personal + work/school Microsoft accounts; matches the `common` tenant endpoint. */
export const MICROSOFT_MAIL_READ_SCOPE = "Mail.Read";
export const MICROSOFT_OFFLINE_ACCESS_SCOPE = "offline_access";
export const MICROSOFT_OPENID_SCOPE = "openid";
/**
 * Least-privilege profile read: lets Relay call Graph `/me` once at connect to
 * learn the account's own email address. Reading `/me` is not covered by
 * `Mail.Read`, so without this Graph returns 403. `User.Read` reads only the
 * signed-in user's own basic profile and is auto-registered on every Entra app.
 */
export const MICROSOFT_USER_READ_SCOPE = "User.Read";
/**
 * Mirrors Gmail's single GMAIL_COMPOSE_SCOPE, but Graph splits compose into
 * two independent delegated permissions: Mail.ReadWrite covers creating and
 * updating drafts, Mail.Send is required separately to actually send one.
 * Both are requested together as one incremental-consent upgrade, matching
 * Gmail's "one compose upgrade covers draft + send" UX.
 */
export const MICROSOFT_MAIL_READWRITE_SCOPE = "Mail.ReadWrite";
export const MICROSOFT_MAIL_SEND_SCOPE = "Mail.Send";

export type RuntimeConfig = Readonly<{
  appUrl: string;
  demoMode: boolean;
  autoMigrate: boolean;
  supportEmail: string;
  allowedEmails: readonly string[];
  googleClientId: string | null;
  googleClientSecret: string | null;
  microsoftClientId: string | null;
  microsoftClientSecret: string | null;
  cookieKey: string | null;
  vaultKek: string | null;
}>;

export type ReadyRuntimeConfig = Omit<
  RuntimeConfig,
  "googleClientId" | "googleClientSecret" | "cookieKey" | "vaultKek"
> & Readonly<{
  googleClientId: string;
  googleClientSecret: string;
  cookieKey: string;
  vaultKek: string;
}>;

const read = (name: string): string | null => {
  const value = process.env[name]?.trim();
  return value ? value : null;
};

const readEmailList = (name: string): readonly string[] =>
  (read(name) ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);

/**
 * Demo mode (see resolveRequestUser in request-user.ts) trusts a plain,
 * unsigned request header as the caller's identity, bypassing Clerk
 * entirely. That's fine for a local walkthrough with no real credentials at
 * stake, but if this env var ever leaked into a deployed environment --
 * copy-pasted .env, a shared staging/prod config, a Vercel dashboard typo --
 * it would let anyone impersonate any Relay user with no session or secret
 * of any kind, on every account tied to that email. NODE_ENV === "development"
 * is the same allow-listed signal instrumentation.ts already uses to detect
 * genuine local dev; everything else (production, preview builds, `next
 * start`) is denied by default rather than pattern-matched against a
 * deny-list that could miss a future environment string.
 */
function assertDemoModeAllowed(demoMode: boolean, appUrl: string): void {
  if (!demoMode) return;
  let hostname: string;
  try {
    hostname = new URL(appUrl).hostname;
  } catch {
    throw new Error("RELAY_APP_URL must be a valid absolute URL.");
  }
  const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  if (process.env.NODE_ENV !== "development" || !loopback) {
    throw new Error(
      "RELAY_DEMO_MODE=true is refused outside loopback-only local development. " +
        "This flag bypasses authentication entirely -- do not set it in any deployed environment.",
    );
  }
}

export function getRuntimeConfig(): RuntimeConfig {
  const appUrl = read("RELAY_APP_URL") ?? "http://localhost:3000";
  const demoMode = read("RELAY_DEMO_MODE") === "true";
  assertDemoModeAllowed(demoMode, appUrl);
  return {
    appUrl,
    demoMode,
    autoMigrate: read("RELAY_AUTO_MIGRATE") === "true",
    supportEmail: read("RELAY_SUPPORT_EMAIL") ?? RELAY_SUPPORT_EMAIL,
    allowedEmails: readEmailList("RELAY_ALLOWED_EMAILS"),
    googleClientId: read("RELAY_GOOGLE_CLIENT_ID"),
    googleClientSecret: read("RELAY_GOOGLE_CLIENT_SECRET"),
    microsoftClientId: read("RELAY_MICROSOFT_CLIENT_ID"),
    microsoftClientSecret: read("RELAY_MICROSOFT_CLIENT_SECRET"),
    cookieKey: read("RELAY_COOKIE_KEY"),
    vaultKek: read("RELAY_VAULT_KEK"),
  };
}

export type GmailReadiness = Readonly<{
  ready: boolean;
  missing: readonly string[];
  redirectUri: string;
}>;

export function getGmailReadiness(config: RuntimeConfig): GmailReadiness {
  const missing: string[] = [];
  if (!config.googleClientId) missing.push("RELAY_GOOGLE_CLIENT_ID");
  if (!config.googleClientSecret) missing.push("RELAY_GOOGLE_CLIENT_SECRET");
  if (!config.cookieKey) missing.push("RELAY_COOKIE_KEY");
  if (!config.vaultKek) missing.push("RELAY_VAULT_KEK");

  return {
    ready: missing.length === 0,
    missing,
    redirectUri: new URL("/api/oauth/google/callback", config.appUrl).toString(),
  };
}

export type VaultReadyConfig = Omit<RuntimeConfig, "vaultKek"> & Readonly<{ vaultKek: string }>;

/**
 * The provider-neutral data plane only needs the envelope vault key -- not any
 * provider's OAuth credentials -- to read, list, and pause stored accounts.
 */
export function requireVaultConfig(config: RuntimeConfig): VaultReadyConfig {
  if (!config.vaultKek) {
    throw new RelayConfigurationError(["RELAY_VAULT_KEK"]);
  }
  return config as VaultReadyConfig;
}

export function requireGmailConfig(config: RuntimeConfig): ReadyRuntimeConfig {
  const readiness = getGmailReadiness(config);
  if (!readiness.ready) {
    throw new RelayConfigurationError(readiness.missing);
  }
  return config as ReadyRuntimeConfig;
}

export type ReadyMicrosoftConfig = Omit<
  RuntimeConfig,
  "microsoftClientId" | "microsoftClientSecret" | "cookieKey" | "vaultKek"
> &
  Readonly<{
    microsoftClientId: string;
    microsoftClientSecret: string;
    cookieKey: string;
    vaultKek: string;
  }>;

export function getMicrosoftReadiness(config: RuntimeConfig): GmailReadiness {
  const missing: string[] = [];
  if (!config.microsoftClientId) missing.push("RELAY_MICROSOFT_CLIENT_ID");
  if (!config.microsoftClientSecret) missing.push("RELAY_MICROSOFT_CLIENT_SECRET");
  if (!config.cookieKey) missing.push("RELAY_COOKIE_KEY");
  if (!config.vaultKek) missing.push("RELAY_VAULT_KEK");

  return {
    ready: missing.length === 0,
    missing,
    redirectUri: new URL("/api/oauth/microsoft/callback", config.appUrl).toString(),
  };
}

export function requireMicrosoftConfig(config: RuntimeConfig): ReadyMicrosoftConfig {
  const readiness = getMicrosoftReadiness(config);
  if (!readiness.ready) {
    throw new RelayConfigurationError(readiness.missing);
  }
  return config as ReadyMicrosoftConfig;
}

/**
 * Phase 6 push notifications are entirely optional: every route and job that
 * uses this config checks `configured` first and no-ops otherwise. Nothing
 * else in the runtime depends on these values being present.
 */
export type PushNotificationConfig = Readonly<
  | { configured: false }
  | {
      configured: true;
      topicName: string;
      pushServiceAccountEmail: string;
      pushAudience: string;
      cronSecret: string;
    }
>;

export function getPushNotificationConfig(): PushNotificationConfig {
  const topicName = read("RELAY_GMAIL_PUBSUB_TOPIC");
  const pushServiceAccountEmail = read("RELAY_GMAIL_PUSH_SERVICE_ACCOUNT_EMAIL");
  const pushAudience = read("RELAY_GMAIL_PUSH_AUDIENCE");
  const cronSecret = read("CRON_SECRET");
  if (!topicName || !pushServiceAccountEmail || !pushAudience || !cronSecret) {
    return { configured: false };
  }
  return { configured: true, topicName, pushServiceAccountEmail, pushAudience, cronSecret };
}

export class RelayConfigurationError extends Error {
  readonly code = "RELAY_CONFIGURATION_REQUIRED";
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(`InboxPort is missing required configuration: ${missing.join(", ")}`);
    this.missing = missing;
  }
}
