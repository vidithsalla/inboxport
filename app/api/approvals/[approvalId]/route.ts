import { apiError, hasValidMutationOrigin, jsonNoStore, requestId } from "../../../../lib/relay/api.ts";
import { getRuntimeConfig } from "../../../../lib/relay/config.ts";
import { GmailAdapter } from "../../../../lib/relay/providers/gmail.ts";
import { OutlookAdapter } from "../../../../lib/relay/providers/outlook.ts";
import { resolveRequestUser } from "../../../../lib/relay/request-user.ts";
import { getDataRuntime } from "../../../../lib/relay/runtime.ts";
import { resolveSendApproval } from "../../../../lib/relay/send-approval-service.ts";

function approvalIdFromPath(request: Request): string | null {
  const match = new URL(request.url).pathname.match(/\/api\/approvals\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export async function POST(request: Request) {
  const id = requestId();
  const approvalId = approvalIdFromPath(request);
  if (!approvalId) return jsonNoStore({ error: "APPROVAL_ID_REQUIRED", request_id: id }, { status: 400 });
  const config = getRuntimeConfig();
  if (!hasValidMutationOrigin(request, config.appUrl)) {
    return jsonNoStore({ error: "MUTATION_ORIGIN_REJECTED", request_id: id }, { status: 403 });
  }
  const user = await resolveRequestUser(request, config);
  if (!user) return jsonNoStore({ error: "AUTHENTICATION_REQUIRED", request_id: id }, { status: 401 });

  try {
    const body = (await request.json()) as { decision?: unknown };
    if (body.decision !== "approve" && body.decision !== "deny" && body.decision !== "cancel") {
      return jsonNoStore({ error: "DECISION_REQUIRED", request_id: id }, { status: 400 });
    }
    const { repository, vault, config: readyConfig } = await getDataRuntime();
    const resolution = await resolveSendApproval(
      {
        repository,
        vault,
        config: readyConfig,
        adapters: { gmail: new GmailAdapter(), outlook: new OutlookAdapter() },
      },
      user.id,
      approvalId,
      body.decision,
      id,
    );
    return jsonNoStore({ approval_id: approvalId, ...resolution });
  } catch (error) {
    return apiError(error, id);
  }
}
