import { apiError, hasValidMutationOrigin, jsonNoStore, requestId } from "../../../../../lib/relay/api.ts";
import { getRuntimeConfig } from "../../../../../lib/relay/config.ts";
import { setInstallationRevoked } from "../../../../../lib/relay/mcp/installation-service.ts";
import { resolveRequestUser } from "../../../../../lib/relay/request-user.ts";
import { getDataRuntime } from "../../../../../lib/relay/runtime.ts";

function installationIdFromPath(request: Request): string | null {
  const match = new URL(request.url).pathname.match(/\/api\/installations\/([^/]+)\/revoke/);
  return match ? decodeURIComponent(match[1]) : null;
}

export async function POST(request: Request) {
  const id = requestId();
  const installationId = installationIdFromPath(request);
  if (!installationId) {
    return jsonNoStore({ error: "INSTALLATION_ID_REQUIRED", request_id: id }, { status: 400 });
  }
  const config = getRuntimeConfig();
  if (!hasValidMutationOrigin(request, config.appUrl)) {
    return jsonNoStore({ error: "MUTATION_ORIGIN_REJECTED", request_id: id }, { status: 403 });
  }
  const user = await resolveRequestUser(request, config);
  if (!user) return jsonNoStore({ error: "AUTHENTICATION_REQUIRED", request_id: id }, { status: 401 });

  try {
    const body = (await request.json()) as { revoked?: unknown };
    if (typeof body.revoked !== "boolean") {
      return jsonNoStore({ error: "REVOKED_BOOLEAN_REQUIRED", request_id: id }, { status: 400 });
    }
    const { repository } = await getDataRuntime();
    const changed = await setInstallationRevoked(
      repository,
      user.id,
      installationId,
      body.revoked,
      id,
    );
    return changed
      ? jsonNoStore({ installation_id: installationId, revoked: body.revoked })
      : jsonNoStore({ error: "INSTALLATION_NOT_FOUND", request_id: id }, { status: 404 });
  } catch (error) {
    return apiError(error, id);
  }
}
