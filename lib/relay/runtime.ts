import { getDb } from "../../db/index.ts";
import { ensureDevelopmentSchema } from "../../db/bootstrap.ts";
import { getRuntimeConfig, requireGmailConfig, requireVaultConfig } from "./config.ts";
import { LocalEnvelopeVault } from "./crypto.ts";
import { LibsqlRelayRepository } from "./libsql-repository.ts";
import { GmailReadOnlyService } from "./gmail-service.ts";

/**
 * Provider-neutral data plane: the repository and the envelope vault, requiring
 * only the vault key (not any provider's OAuth credentials). Used for account
 * lookup, listing, and pause/resume so those work for any provider regardless
 * of which providers happen to be configured.
 */
export async function getDataRuntime() {
  const config = requireVaultConfig(getRuntimeConfig());
  await ensureDevelopmentSchema(config.autoMigrate);
  const repository = new LibsqlRelayRepository(await getDb());
  const vault = await LocalEnvelopeVault.fromEncodedKey(config.vaultKek);
  return { config, repository, vault };
}

export async function getGmailRuntime() {
  const config = requireGmailConfig(getRuntimeConfig());
  await ensureDevelopmentSchema(config.autoMigrate);
  const repository = new LibsqlRelayRepository(await getDb());
  const vault = await LocalEnvelopeVault.fromEncodedKey(config.vaultKek);
  const cookieVault = await LocalEnvelopeVault.fromEncodedKey(config.cookieKey);
  const service = new GmailReadOnlyService(repository, vault, config);
  return { config, repository, vault, cookieVault, service };
}
