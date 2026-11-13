import { getDb } from "../../db/index.ts";
import { ensureDevelopmentSchema } from "../../db/bootstrap.ts";
import { getRuntimeConfig, requireMicrosoftConfig } from "./config.ts";
import { LocalEnvelopeVault } from "./crypto.ts";
import { LibsqlRelayRepository } from "./libsql-repository.ts";
import { OutlookReadOnlyService } from "./outlook-service.ts";

export async function getOutlookRuntime() {
  const config = requireMicrosoftConfig(getRuntimeConfig());
  await ensureDevelopmentSchema(config.autoMigrate);
  const repository = new LibsqlRelayRepository(await getDb());
  const vault = await LocalEnvelopeVault.fromEncodedKey(config.vaultKek);
  const cookieVault = await LocalEnvelopeVault.fromEncodedKey(config.cookieKey);
  const service = new OutlookReadOnlyService(repository, vault, config);
  return { config, repository, vault, cookieVault, service };
}
