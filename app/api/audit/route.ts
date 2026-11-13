import { apiError, jsonNoStore, parsePositiveInteger, requestId } from "../../../lib/relay/api.ts";
import { getRuntimeConfig } from "../../../lib/relay/config.ts";
import { resolveRequestUser } from "../../../lib/relay/request-user.ts";
import { getDataRuntime } from "../../../lib/relay/runtime.ts";

export async function GET(request: Request) {
  const id = requestId();
  const config = getRuntimeConfig();
  const user = await resolveRequestUser(request, config);
  if (!user) return jsonNoStore({ error: "AUTHENTICATION_REQUIRED", request_id: id }, { status: 401 });
  try {
    const { repository } = await getDataRuntime();
    const limit = parsePositiveInteger(new URL(request.url).searchParams.get("limit"), 50, 100);
    return jsonNoStore({ events: await repository.listAudit(user.id, limit) });
  } catch (error) {
    return apiError(error, id);
  }
}
