import { apiError, jsonNoStore, requestId } from "../../../lib/relay/api.ts";
import { getRuntimeConfig } from "../../../lib/relay/config.ts";
import { GmailAdapter } from "../../../lib/relay/providers/gmail.ts";
import { OutlookAdapter } from "../../../lib/relay/providers/outlook.ts";
import { resolveRequestUser } from "../../../lib/relay/request-user.ts";
import { getDataRuntime } from "../../../lib/relay/runtime.ts";
import { listPendingApprovals } from "../../../lib/relay/send-approval-service.ts";

export async function GET(request: Request) {
  const id = requestId();
  const config = getRuntimeConfig();
  const user = await resolveRequestUser(request, config);
  if (!user) return jsonNoStore({ error: "AUTHENTICATION_REQUIRED", request_id: id }, { status: 401 });

  try {
    const { repository, vault, config: readyConfig } = await getDataRuntime();
    const approvals = await listPendingApprovals(
      {
        repository,
        vault,
        config: readyConfig,
        adapters: { gmail: new GmailAdapter(), outlook: new OutlookAdapter() },
      },
      user.id,
    );
    return jsonNoStore({ approvals });
  } catch (error) {
    return apiError(error, id);
  }
}
