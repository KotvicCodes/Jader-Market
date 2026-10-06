import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export function createDatabase(url: string) {
  const client = postgres(url, {
    max: 5,
    connect_timeout: 3,
    idle_timeout: 20,
    onnotice: () => {},
    debug: false,
  });
  return { client, db: drizzle(client, { schema }) };
}

let connection: ReturnType<typeof createDatabase> | undefined;

export function getDatabase() {
  const url = process.env.DATABASE_URL;
  if (!url) return undefined;
  try {
    connection ??= createDatabase(url);
    return connection;
  } catch {
    return undefined;
  }
}
