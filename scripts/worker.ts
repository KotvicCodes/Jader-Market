import "dotenv/config";
import { getDatabase } from "../src/db/client";

// Foundation connectivity check only. No financial jobs exist yet.
const connection = getDatabase();
if (!connection) {
  console.error("Worker unavailable: database configuration is required.");
  process.exitCode = 1;
} else {
  try {
    await connection.client`select 1`;
    console.info("Worker database is ready. No jobs are enabled in this release.");
  } catch {
    console.error("Worker unavailable: database readiness check failed.");
    process.exitCode = 1;
  } finally {
    await connection.client.end();
  }
}
