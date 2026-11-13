import { apiError, jsonNoStore, requestId } from "../../../lib/relay/api.ts";
import { listPublicAccounts } from "../../../lib/relay/account-view.ts";
import { getGmailReadiness, getMicrosoftReadiness, getRuntimeConfig } from "../../../lib/relay/config.ts";
import { resolveRequestUser } from "../../../lib/relay/request-user.ts";
import { getDataRuntime } from "../../../lib/relay/runtime.ts";

export async function GET(request: Request) {
  const id = requestId();
  const config = getRuntimeConfig();
  const user = await resolveRequestUser(request, config);
  if (!user) return jsonNoStore({ error: "AUTHENTICATION_REQUIRED", request_id: id }, { status: 401 });

  const gmailReadiness = getGmailReadiness(config);
  const microsoftReadiness = getMicrosoftReadiness(config);

  try {
    // Listing accounts needs only the data plane (vault + db), so both Gmail
    // and Outlook inboxes appear regardless of which provider OAuth clients
    // are configured. The readiness fields below drive the connect flow only.
    const { repository, vault } = await getDataRuntime();
    const accounts = await listPublicAccounts(vault, repository, user.id);
    return jsonNoStore({
      credential_ready: gmailReadiness.ready,
      redirect_uri: gmailReadiness.redirectUri,
      missing: gmailReadiness.missing,
      accounts,
      microsoft: {
        credential_ready: microsoftReadiness.ready,
        missing: microsoftReadiness.missing,
      },
    });
  } catch (error) {
    return apiError(error, id);
  }
}
