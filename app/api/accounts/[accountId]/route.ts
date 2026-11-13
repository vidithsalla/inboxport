import { accountIdFromPath, apiError, hasValidMutationOrigin, jsonNoStore, requestId } from "../../../../lib/relay/api.ts";
import { getRuntimeConfig } from "../../../../lib/relay/config.ts";
import { resolveRequestUser } from "../../../../lib/relay/request-user.ts";
import { getDataRuntime, getGmailRuntime } from "../../../../lib/relay/runtime.ts";
import { getOutlookRuntime } from "../../../../lib/relay/outlook-runtime.ts";

export async function DELETE(request: Request) {
  const id = requestId();
  const accountId = accountIdFromPath(request);
  if (!accountId) return jsonNoStore({ error: "ACCOUNT_ID_REQUIRED", request_id: id }, { status: 400 });
  const config = getRuntimeConfig();
  if (!hasValidMutationOrigin(request, config.appUrl)) {
    return jsonNoStore({ error: "MUTATION_ORIGIN_REJECTED", request_id: id }, { status: 403 });
  }
  const user = await resolveRequestUser(request, config);
  if (!user) return jsonNoStore({ error: "AUTHENTICATION_REQUIRED", request_id: id }, { status: 401 });

  try {
    const { repository } = await getDataRuntime();
    const account = await repository.getAccount(user.id, accountId);
    if (!account) return jsonNoStore({ error: "ACCOUNT_NOT_FOUND", request_id: id }, { status: 404 });

    // Each provider's own service knows how (or whether) to revoke on the provider's side;
    // Gmail attempts real revocation, Outlook has no equivalent endpoint and disconnects locally.
    const state =
      account.provider === "microsoft"
        ? await (await getOutlookRuntime()).service.disconnect(user, accountId, id)
        : await (await getGmailRuntime()).service.disconnect(user, accountId, id);
    if (state === "not_found") {
      return jsonNoStore({ error: "ACCOUNT_NOT_FOUND", request_id: id }, { status: 404 });
    }
    return jsonNoStore(
      { account_id: accountId, state },
      { status: state === "disconnected" ? 200 : 202 },
    );
  } catch (error) {
    return apiError(error, id);
  }
}
