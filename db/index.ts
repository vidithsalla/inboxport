import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema.ts";

let client: Client | null = null;
let database: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDbClient(): Client {
  if (client) return client;

  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !authToken) {
    throw new Error("Turso is unavailable. Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.");
  }

  client = createClient({ url, authToken });
  return client;
}

export async function getDb() {
  database ??= drizzle(getDbClient(), { schema });
  return database;
}
