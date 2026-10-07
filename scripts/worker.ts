import "dotenv/config";
import { setTimeout as delay } from "node:timers/promises";
import { getDatabase } from "../src/db/client";
import { expireTradingOrders } from "../src/db/trading";

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
      await expireTradingOrders();
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
