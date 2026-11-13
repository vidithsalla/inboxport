import { apiError, hasValidMutationOrigin, jsonNoStore, parsePositiveInteger, requestId } from "../../../../lib/relay/api.ts";
import { getRuntimeConfig } from "../../../../lib/relay/config.ts";
import { resolveRequestUser } from "../../../../lib/relay/request-user.ts";
import { getDataRuntime, getGmailRuntime } from "../../../../lib/relay/runtime.ts";
import { getOutlookRuntime } from "../../../../lib/relay/outlook-runtime.ts";

export async function POST(request: Request) {
  const id = requestId();
  const config = getRuntimeConfig();
  if (!hasValidMutationOrigin(request, config.appUrl)) {
    return jsonNoStore({ error: "MUTATION_ORIGIN_REJECTED", request_id: id }, { status: 403 });
  }
  const user = await resolveRequestUser(request, config);
  if (!user) return jsonNoStore({ error: "AUTHENTICATION_REQUIRED", request_id: id }, { status: 401 });
  let body: { account_id?: unknown; q?: unknown; max_results?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonNoStore({ error: "JSON_BODY_REQUIRED", request_id: id }, { status: 400 });
  }
  const accountId = typeof body.account_id === "string" ? body.account_id.trim() : "";
  const query = typeof body.q === "string" ? body.q.trim() : "";
  if (!accountId) return jsonNoStore({ error: "ACCOUNT_ID_REQUIRED", request_id: id }, { status: 400 });
  if (!query || query.length > 512) {
    return jsonNoStore({ error: "SEARCH_QUERY_INVALID", request_id: id }, { status: 400 });
  }
  const maxResults = parsePositiveInteger(
    typeof body.max_results === "number" || typeof body.max_results === "string"
      ? String(body.max_results)
      : null,
    20,
    50,
  );

  try {
    const { repository } = await getDataRuntime();
    const account = await repository.getAccount(user.id, accountId);
    if (!account) return jsonNoStore({ error: "ACCOUNT_NOT_FOUND", request_id: id }, { status: 404 });
    const results =
      account.provider === "microsoft"
        ? await (await getOutlookRuntime()).service.search(user, accountId, query, maxResults, id)
        : await (await getGmailRuntime()).service.search(user, accountId, query, maxResults, id);
    return jsonNoStore({ account_id: accountId, results });
  } catch (error) {
    return apiError(error, id);
  }
}
