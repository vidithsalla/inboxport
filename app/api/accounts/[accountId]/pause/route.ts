import { accountIdFromPath, apiError, hasValidMutationOrigin, jsonNoStore, requestId } from "../../../../../lib/relay/api.ts";
import { pauseAccount } from "../../../../../lib/relay/account-view.ts";
import { getRuntimeConfig } from "../../../../../lib/relay/config.ts";
import { resolveRequestUser } from "../../../../../lib/relay/request-user.ts";
import { getDataRuntime } from "../../../../../lib/relay/runtime.ts";

export async function POST(request: Request) {
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
    const body = (await request.json()) as { paused?: unknown };
    if (typeof body.paused !== "boolean") {
      return jsonNoStore({ error: "PAUSED_BOOLEAN_REQUIRED", request_id: id }, { status: 400 });
    }
    const { repository } = await getDataRuntime();
    const changed = await pauseAccount(repository, user, accountId, body.paused, id);
    return changed
      ? jsonNoStore({ account_id: accountId, paused: body.paused })
      : jsonNoStore({ error: "ACCOUNT_NOT_FOUND", request_id: id }, { status: 404 });
  } catch (error) {
    return apiError(error, id);
  }
}
