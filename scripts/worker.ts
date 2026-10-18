import "dotenv/config";
import { setTimeout as delay } from "node:timers/promises";
import { getDatabase } from "../src/db/client";
import { expireTradingOrders } from "../src/db/trading";

import { recordWorkerStatus } from "../src/domain/worker-status";
import { settleMarkets } from "../src/db/settlement";

const connection = getDatabase();
let stopping = false;
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });
if (!connection) {
  console.error("Worker unavailable: database configuration is required.");
  process.exitCode = 1;
} else {
  try {
    do {
      let passSucceeded = false;
      try {
        await expireTradingOrders();
        await settleMarkets();
        passSucceeded = true;
      } catch { /* Record the maintenance outcome separately from status I/O. */ }
      if (process.env.WORKER_STATUS_FILE) {
        try {
          await recordWorkerStatus(process.env.WORKER_STATUS_FILE, passSucceeded);
        } catch {
          console.error("Worker status could not be recorded.");
        }
      }
      if (!passSucceeded) {
        if (process.argv.includes("--once")) throw new Error("maintenance_failed");
        console.error("Trading maintenance pass failed; retrying.");
      }
      if (process.argv.includes("--once") || stopping) break;
      await delay(1000);
    } while (!stopping);
    console.info("Trading maintenance completed.");
  } catch {
    console.error("Worker unavailable: trading maintenance failed.");
    process.exitCode = 1;
  } finally {
    await connection.client.end();
  }
}
