import { getDb } from "../../../../db/index.ts";
import { ensureDevelopmentSchema } from "../../../../db/bootstrap.ts";
import { jsonNoStore, requestId } from "../../../../lib/relay/api.ts";
import { getPushNotificationConfig, getRuntimeConfig, requireGmailConfig } from "../../../../lib/relay/config.ts";
import { LocalEnvelopeVault } from "../../../../lib/relay/crypto.ts";
import { handleGmailPushNotification, verifyPubSubPushToken } from "../../../../lib/relay/gmail-sync-service.ts";
import { LibsqlRelayRepository } from "../../../../lib/relay/libsql-repository.ts";
import { GmailAdapter } from "../../../../lib/relay/providers/gmail.ts";

export const runtime = "nodejs";

type PubSubPushBody = Readonly<{ message?: Readonly<{ data?: string }> }>;

/**
 * Receives Google Cloud Pub/Sub push deliveries for Gmail mailbox change
 * notifications. Always acknowledges with 200 once the request is
 * authenticated, even on internal failure, to avoid Pub/Sub redelivery
 * storms; failures are recorded on the account's sync/health state instead.
 */
export async function POST(request: Request) {
  const id = requestId();
  const pushConfig = getPushNotificationConfig();
  if (!pushConfig.configured) {
    return jsonNoStore({ error: "PUSH_NOT_CONFIGURED", request_id: id }, { status: 503 });
  }

  const authHeader = request.headers.get("authorization");
  const idToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!idToken) {
    return jsonNoStore({ error: "AUTHENTICATION_REQUIRED", request_id: id }, { status: 401 });
  }
  const verified = await verifyPubSubPushToken(
    idToken,
    pushConfig.pushAudience,
    pushConfig.pushServiceAccountEmail,
  );
  if (!verified) {
    return jsonNoStore({ error: "AUTHENTICATION_REQUIRED", request_id: id }, { status: 401 });
  }

  let body: PubSubPushBody;
  try {
    body = (await request.json()) as PubSubPushBody;
  } catch {
    return jsonNoStore({ error: "JSON_BODY_REQUIRED", request_id: id }, { status: 400 });
  }

  const data = body.message?.data;
  if (!data) return jsonNoStore({ ok: true });

  let decoded: { emailAddress?: string; historyId?: string };
  try {
    decoded = JSON.parse(Buffer.from(data, "base64").toString("utf-8")) as typeof decoded;
  } catch {
    return jsonNoStore({ ok: true });
  }
  if (!decoded.emailAddress || !decoded.historyId) return jsonNoStore({ ok: true });

  try {
    const config = requireGmailConfig(getRuntimeConfig());
    await ensureDevelopmentSchema(config.autoMigrate);
    const repository = new LibsqlRelayRepository(await getDb());
    const vault = await LocalEnvelopeVault.fromEncodedKey(config.vaultKek);
    await handleGmailPushNotification(
      { repository, vault, config, adapter: new GmailAdapter() },
      decoded.emailAddress,
      decoded.historyId,
      id,
    );
  } catch {
    // Swallow: acknowledging avoids a redelivery storm for a failure a retry can't fix.
  }
  return jsonNoStore({ ok: true });
}
