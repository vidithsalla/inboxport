import { getDb } from "../../../../db/index.ts";
import { ensureDevelopmentSchema } from "../../../../db/bootstrap.ts";
import { apiError, jsonNoStore, requestId } from "../../../../lib/relay/api.ts";
import { getPushNotificationConfig, getRuntimeConfig, requireGmailConfig } from "../../../../lib/relay/config.ts";
import { LocalEnvelopeVault } from "../../../../lib/relay/crypto.ts";
import { isValidCronSecret } from "../../../../lib/relay/cron-auth.ts";
import { renewAllWatches } from "../../../../lib/relay/gmail-sync-service.ts";
import { LibsqlRelayRepository } from "../../../../lib/relay/libsql-repository.ts";
import { GmailAdapter } from "../../../../lib/relay/providers/gmail.ts";

export const runtime = "nodejs";

/**
 * Vercel Cron target. Gmail's `users.watch` expires after at most 7 days
 * with no automatic renewal, so this re-registers it for every connected
 * account daily. No-ops entirely if Phase 6 push configuration isn't set.
 */
export async function GET(request: Request) {
  const id = requestId();
  const pushConfig = getPushNotificationConfig();
  if (!pushConfig.configured) {
    return jsonNoStore({ status: "not_configured", request_id: id });
  }

  if (!isValidCronSecret(request.headers.get("authorization"), pushConfig.cronSecret)) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const config = requireGmailConfig(getRuntimeConfig());
    await ensureDevelopmentSchema(config.autoMigrate);
    const repository = new LibsqlRelayRepository(await getDb());
    const vault = await LocalEnvelopeVault.fromEncodedKey(config.vaultKek);
    const result = await renewAllWatches(
      { repository, vault, config, adapter: new GmailAdapter() },
      pushConfig.topicName,
      id,
    );
    return jsonNoStore({ status: "ok", ...result, request_id: id });
  } catch (error) {
    return apiError(error, id);
  }
}
