import {
  hasValidMutationOrigin,
  jsonNoStore,
  requestId,
} from "../../../lib/relay/api.ts";
import { getRuntimeConfig } from "../../../lib/relay/config.ts";
import { resolveRequestUser } from "../../../lib/relay/request-user.ts";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: Request) {
  const id = requestId();
  const config = getRuntimeConfig();

  if (!hasValidMutationOrigin(request, config.appUrl)) {
    return jsonNoStore(
      { error: "MUTATION_ORIGIN_REJECTED", request_id: id },
      { status: 403 },
    );
  }

  const user = await resolveRequestUser(request, config);
  if (!user) {
    return jsonNoStore(
      { error: "AUTHENTICATION_REQUIRED", request_id: id },
      { status: 401 },
    );
  }

  let body: { email?: unknown; feedback?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonNoStore(
      { error: "JSON_BODY_REQUIRED", request_id: id },
      { status: 400 },
    );
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const feedback = typeof body.feedback === "string" ? body.feedback.trim() : "";
  if (
    email.length > 320 ||
    (email.length > 0 && !EMAIL_PATTERN.test(email)) ||
    feedback.length < 3 ||
    feedback.length > 5000
  ) {
    return jsonNoStore(
      { error: "FEEDBACK_INVALID", request_id: id },
      { status: 400 },
    );
  }

  const configuredEndpoint = process.env.RELAY_FEEDBACK_ENDPOINT?.trim();
  if (!configuredEndpoint) {
    return jsonNoStore(
      { error: "FEEDBACK_NOT_CONFIGURED", request_id: id },
      { status: 503 },
    );
  }

  let endpoint: URL;
  try {
    endpoint = new URL(configuredEndpoint);
    if (
      endpoint.protocol !== "https:" ||
      endpoint.username ||
      endpoint.password
    ) {
      throw new Error("HTTPS_ENDPOINT_WITHOUT_EMBEDDED_CREDENTIALS_REQUIRED");
    }
  } catch {
    return jsonNoStore(
      { error: "FEEDBACK_NOT_CONFIGURED", request_id: id },
      { status: 503 },
    );
  }

  try {
    const delivery = await fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        referer: config.appUrl,
      },
      body: JSON.stringify({
        ...(email ? { email } : {}),
        feedback,
        message: feedback,
        submitted_at: new Date().toISOString(),
        source: "InboxPort console",
      }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });

    if (!delivery.ok) {
      return jsonNoStore(
        { error: "FEEDBACK_DELIVERY_FAILED", request_id: id },
        { status: 502 },
      );
    }

    return jsonNoStore({ submitted: true, request_id: id }, { status: 201 });
  } catch {
    return jsonNoStore(
      { error: "FEEDBACK_DELIVERY_FAILED", request_id: id },
      { status: 502 },
    );
  }
}
