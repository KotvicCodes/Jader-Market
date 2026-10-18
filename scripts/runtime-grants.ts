import "dotenv/config";
import { getDatabase } from "../src/db/client";
import { assertDatabaseReady } from "../src/db/readiness";
import { grantRuntimeRole } from "../src/db/runtime-role";

const connection = getDatabase();
try {
  if (!connection) throw new Error("configuration");
  await assertDatabaseReady(connection.db);
  await grantRuntimeRole(connection.db, "jader_runtime");
  console.info("Runtime database grants applied.");
} catch {
  console.error("Runtime grants failed: check owner connection, migrations and runtime role privileges.");
  process.exitCode = 1;
} finally { await connection?.client.end(); }
