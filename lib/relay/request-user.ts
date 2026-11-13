import { auth, currentUser } from "@clerk/nextjs/server";
import type { RuntimeConfig } from "./config.ts";
import { sha256Base64Url } from "./crypto.ts";

const USER_EMAIL_HEADER = "oai-authenticated-user-email";

export type RequestUser = Readonly<{
  id: string;
  email: string | null;
}>;

/**
 * Derives Relay's internal user id from a raw Clerk user id. Shared by the
 * console (via Clerk's session `auth()`) and the MCP server (via the OAuth
 * access token's verified claims) so both surfaces join to the same
 * `relay_accounts.user_id` / `relay_installations.user_id` rows.
 */
export function deriveRelayUserId(clerkUserId: string): Promise<string> {
  return sha256Base64Url(`relay-mail:user:clerk:${clerkUserId}`);
}

export async function resolveRequestUser(
  request: Request,
  config: RuntimeConfig,
): Promise<RequestUser | null> {
  if (config.demoMode) {
    const email =
      request.headers.get(USER_EMAIL_HEADER)?.trim().toLowerCase() ||
      config.supportEmail.toLowerCase();
    return {
      id: await sha256Base64Url(`relay-mail:user:${email}`),
      email,
    };
  }

  const { userId } = await auth();
  if (!userId) return null;
  const clerkUser = await currentUser();
  const email = clerkUser?.emailAddresses
    .find((address) => address.id === clerkUser.primaryEmailAddressId)
    ?.emailAddress.trim().toLowerCase();
  if (!email || !config.allowedEmails.includes(email)) return null;
  return {
    id: await deriveRelayUserId(userId),
    email,
  };
}
