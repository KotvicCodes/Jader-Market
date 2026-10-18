import "dotenv/config";
import { setTimeout as delay } from "node:timers/promises";
import { getDatabase } from "../src/db/client";
import { operationsSnapshot } from "../src/db/operations";
const connection = getDatabase();
let stopping = false;
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });
try {
  do {
    try {
      if (!connection || !process.env.WORKER_STATUS_FILE) throw new Error("configuration");
      const snapshot = await operationsSnapshot(connection.db, process.env.WORKER_STATUS_FILE);
      console.info(JSON.stringify(snapshot));
      process.exitCode = snapshot.status === "ok" ? 0 : 1;
    } catch {
      console.error('{"status":"critical","alerts":["operations_unavailable"]}');
      process.exitCode = 1;
    }
    if (!process.argv.includes("--watch") || stopping) break;
    await delay(10_000);
  } while (!stopping);
} finally { await connection?.client.end(); }
