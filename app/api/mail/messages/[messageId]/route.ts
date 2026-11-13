import { apiError, jsonNoStore, requestId, resourceIdFromPath } from "../../../../../lib/relay/api.ts";
import { getRuntimeConfig } from "../../../../../lib/relay/config.ts";
import { resolveRequestUser } from "../../../../../lib/relay/request-user.ts";
import { getDataRuntime, getGmailRuntime } from "../../../../../lib/relay/runtime.ts";
import { getOutlookRuntime } from "../../../../../lib/relay/outlook-runtime.ts";

export async function GET(request: Request) {
  const id = requestId();
  const config = getRuntimeConfig();
  const user = await resolveRequestUser(request, config);
  if (!user) return jsonNoStore({ error: "AUTHENTICATION_REQUIRED", request_id: id }, { status: 401 });
  const accountId = new URL(request.url).searchParams.get("account_id")?.trim();
  const messageId = resourceIdFromPath(request, "messages");
  if (!accountId || !messageId) {
    return jsonNoStore({ error: "ACCOUNT_AND_MESSAGE_REQUIRED", request_id: id }, { status: 400 });
  }
  try {
    const { repository } = await getDataRuntime();
    const account = await repository.getAccount(user.id, accountId);
    if (!account) return jsonNoStore({ error: "ACCOUNT_NOT_FOUND", request_id: id }, { status: 404 });
    const message =
      account.provider === "microsoft"
        ? await (await getOutlookRuntime()).service.getMessage(user, accountId, messageId, id)
        : await (await getGmailRuntime()).service.getMessage(user, accountId, messageId, id);
    return jsonNoStore({ account_id: accountId, message });
  } catch (error) {
    return apiError(error, id);
  }
}
