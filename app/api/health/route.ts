import { getGmailReadiness, getMicrosoftReadiness, getRuntimeConfig, RELAY_MAIL_NAME } from "../../../lib/relay/config.ts";
import { jsonNoStore } from "../../../lib/relay/api.ts";

export async function GET() {
  const config = getRuntimeConfig();
  const gmail = getGmailReadiness(config);
  const microsoft = getMicrosoftReadiness(config);
  return jsonNoStore({
    service: RELAY_MAIL_NAME,
    status: "ok",
    gmail: {
      credential_ready: gmail.ready,
    },
    microsoft: {
      credential_ready: microsoft.ready,
    },
  });
}
