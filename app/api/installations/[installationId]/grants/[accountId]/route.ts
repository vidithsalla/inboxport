import { apiError, hasValidMutationOrigin, jsonNoStore, requestId } from "../../../../../../lib/relay/api.ts";
import { getRuntimeConfig } from "../../../../../../lib/relay/config.ts";
import { MAIL_PERMISSIONS } from "../../../../../../lib/relay/contracts.ts";
import {
  grantAccountAccess,
  revokeAccountAccess,
} from "../../../../../../lib/relay/mcp/installation-service.ts";

const NO_PERMISSIONS = Object.fromEntries(MAIL_PERMISSIONS.map((permission) => [permission, false]));
import { resolveRequestUser } from "../../../../../../lib/relay/request-user.ts";
import { getDataRuntime } from "../../../../../../lib/relay/runtime.ts";

function pathIds(request: Request): { installationId: string | null; accountId: string | null } {
  const match = new URL(request.url).pathname.match(
    /\/api\/installations\/([^/]+)\/grants\/([^/]+)/,
  );
  return {
    installationId: match ? decodeURIComponent(match[1]) : null,
    accountId: match ? decodeURIComponent(match[2]) : null,
  };
}

export async function POST(request: Request) {
  const id = requestId();
  const { installationId, accountId } = pathIds(request);
  if (!installationId || !accountId) {
    return jsonNoStore({ error: "INSTALLATION_AND_ACCOUNT_ID_REQUIRED", request_id: id }, { status: 400 });
  }
  const config = getRuntimeConfig();
  if (!hasValidMutationOrigin(request, config.appUrl)) {
    return jsonNoStore({ error: "MUTATION_ORIGIN_REJECTED", request_id: id }, { status: 403 });
  }
  const user = await resolveRequestUser(request, config);
  if (!user) return jsonNoStore({ error: "AUTHENTICATION_REQUIRED", request_id: id }, { status: 401 });

  try {
    const body = (await request.json()) as { permissions?: unknown };
    if (
      !Array.isArray(body.permissions) ||
      !body.permissions.every((permission) => typeof permission === "string")
    ) {
      return jsonNoStore({ error: "PERMISSIONS_ARRAY_REQUIRED", request_id: id }, { status: 400 });
    }
    const { repository } = await getDataRuntime();
    const grant = await grantAccountAccess(
      repository,
      user.id,
      installationId,
      accountId,
      body.permissions,
      id,
    );
    return jsonNoStore({
      installation_id: installationId,
      account_id: accountId,
      // A request with no true permissions is treated as a revoke (see
      // grantAccountAccess) rather than leaving an all-false grant row
      // behind, so there is no persisted grant to read permissions from.
      permissions: grant?.permissions ?? NO_PERMISSIONS,
    });
  } catch (error) {
    return apiError(error, id);
  }
}

export async function DELETE(request: Request) {
  const id = requestId();
  const { installationId, accountId } = pathIds(request);
  if (!installationId || !accountId) {
    return jsonNoStore({ error: "INSTALLATION_AND_ACCOUNT_ID_REQUIRED", request_id: id }, { status: 400 });
  }
  const config = getRuntimeConfig();
  if (!hasValidMutationOrigin(request, config.appUrl)) {
    return jsonNoStore({ error: "MUTATION_ORIGIN_REJECTED", request_id: id }, { status: 403 });
  }
  const user = await resolveRequestUser(request, config);
  if (!user) return jsonNoStore({ error: "AUTHENTICATION_REQUIRED", request_id: id }, { status: 401 });

  try {
    const { repository } = await getDataRuntime();
    const removed = await revokeAccountAccess(repository, user.id, installationId, accountId, id);
    return removed
      ? jsonNoStore({ installation_id: installationId, account_id: accountId, revoked: true })
      : jsonNoStore({ error: "GRANT_NOT_FOUND", request_id: id }, { status: 404 });
  } catch (error) {
    return apiError(error, id);
  }
}
