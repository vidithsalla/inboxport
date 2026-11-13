import { apiError, jsonNoStore, requestId } from "../../../lib/relay/api.ts";
import { getRuntimeConfig } from "../../../lib/relay/config.ts";
import { listInstallationsForUser } from "../../../lib/relay/mcp/installation-service.ts";
import { resolveRequestUser } from "../../../lib/relay/request-user.ts";
import { getDataRuntime } from "../../../lib/relay/runtime.ts";

export async function GET(request: Request) {
  const id = requestId();
  const config = getRuntimeConfig();
  const user = await resolveRequestUser(request, config);
  if (!user) return jsonNoStore({ error: "AUTHENTICATION_REQUIRED", request_id: id }, { status: 401 });

  try {
    const { repository } = await getDataRuntime();
    const installations = await listInstallationsForUser(repository, user.id);
    return jsonNoStore({ installations });
  } catch (error) {
    return apiError(error, id);
  }
}
