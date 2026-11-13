import {
  apiError,
  hasValidMutationOrigin,
  jsonNoStore,
  requestId,
} from "../../../../lib/relay/api.ts";
import { getRuntimeConfig } from "../../../../lib/relay/config.ts";
import {
  removeInstallation,
  renameInstallation,
} from "../../../../lib/relay/mcp/installation-service.ts";
import { resolveRequestUser } from "../../../../lib/relay/request-user.ts";
import { getDataRuntime } from "../../../../lib/relay/runtime.ts";

function installationIdFromPath(request: Request): string | null {
  const match = new URL(request.url).pathname.match(/\/api\/installations\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

type MutationAuthorization =
  | Readonly<{ ok: false; response: Response }>
  | Readonly<{
      ok: true;
      id: string;
      installationId: string;
      user: NonNullable<Awaited<ReturnType<typeof resolveRequestUser>>>;
    }>;

async function authorizeMutation(request: Request): Promise<MutationAuthorization> {
  const id = requestId();
  const installationId = installationIdFromPath(request);
  if (!installationId) {
    return {
      ok: false,
      response: jsonNoStore(
        { error: "INSTALLATION_ID_REQUIRED", request_id: id },
        { status: 400 },
      ),
    };
  }
  const config = getRuntimeConfig();
  if (!hasValidMutationOrigin(request, config.appUrl)) {
    return {
      ok: false,
      response: jsonNoStore(
        { error: "MUTATION_ORIGIN_REJECTED", request_id: id },
        { status: 403 },
      ),
    };
  }
  const user = await resolveRequestUser(request, config);
  if (!user) {
    return {
      ok: false,
      response: jsonNoStore(
        { error: "AUTHENTICATION_REQUIRED", request_id: id },
        { status: 401 },
      ),
    };
  }
  return { ok: true, id, installationId, user };
}

export async function PATCH(request: Request) {
  const authorization = await authorizeMutation(request);
  if (!authorization.ok) return authorization.response;

  let body: { client_name?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonNoStore(
      { error: "JSON_BODY_REQUIRED", request_id: authorization.id },
      { status: 400 },
    );
  }

  const clientName =
    typeof body.client_name === "string" ? body.client_name.trim() : "";
  if (
    !clientName ||
    clientName.length > 80 ||
    /[\u0000-\u001f\u007f]/.test(clientName)
  ) {
    return jsonNoStore(
      { error: "CLIENT_NAME_INVALID", request_id: authorization.id },
      { status: 400 },
    );
  }

  try {
    const { repository } = await getDataRuntime();
    const changed = await renameInstallation(
      repository,
      authorization.user.id,
      authorization.installationId,
      clientName,
      authorization.id,
    );
    return changed
      ? jsonNoStore({
          installation_id: authorization.installationId,
          client_name: clientName,
        })
      : jsonNoStore(
          { error: "INSTALLATION_NOT_FOUND", request_id: authorization.id },
          { status: 404 },
        );
  } catch (error) {
    return apiError(error, authorization.id);
  }
}

export async function DELETE(request: Request) {
  const authorization = await authorizeMutation(request);
  if (!authorization.ok) return authorization.response;

  try {
    const { repository } = await getDataRuntime();
    const removed = await removeInstallation(
      repository,
      authorization.user.id,
      authorization.installationId,
      authorization.id,
    );
    return removed
      ? jsonNoStore({
          installation_id: authorization.installationId,
          removed: true,
        })
      : jsonNoStore(
          { error: "INSTALLATION_NOT_FOUND", request_id: authorization.id },
          { status: 404 },
        );
  } catch (error) {
    return apiError(error, authorization.id);
  }
}
