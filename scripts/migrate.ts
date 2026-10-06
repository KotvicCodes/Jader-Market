import "dotenv/config";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { getDatabase } from "../src/db/client";

const connection = getDatabase();
if (!connection) {
  console.error("Migration unavailable: database configuration is required.");
  process.exitCode = 1;
} else {
  try {
    await migrate(connection.db, { migrationsFolder: "drizzle" });
    console.info("Database migrations completed.");
  } catch {
    console.error("Migration failed. Check database readiness and migration compatibility.");
    process.exitCode = 1;
  } finally {
    await connection.client.end();
  }
}
