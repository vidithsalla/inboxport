import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { DEVELOPMENT_SCHEMA } from "../../../db/bootstrap.ts";
import * as schema from "../../../db/schema.ts";
import { LibsqlRelayRepository } from "../../../lib/relay/libsql-repository.ts";

/**
 * A fresh, in-process libsql database per call -- not the app's Turso-backed
 * getDb() singleton, which requires TURSO_DATABASE_URL/TURSO_AUTH_TOKEN.
 * Exercises the real LibsqlRelayRepository (and real SQL, real constraints,
 * real atomicity) with no network and no shared state between tests.
 */
export async function createSqliteRepository(): Promise<LibsqlRelayRepository> {
  const client = createClient({ url: ":memory:" });
  await client.executeMultiple(DEVELOPMENT_SCHEMA);
  const db = drizzle(client, { schema });
  return new LibsqlRelayRepository(db);
}
