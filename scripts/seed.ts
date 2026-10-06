import "dotenv/config";
import { getDatabase } from "../src/db/client";
import { syntheticMarkets } from "../src/db/fixtures";
import { markets } from "../src/db/schema";

const connection = getDatabase();
if (!connection || process.env.NODE_ENV === "production") {
  console.error("Synthetic seed unavailable. Use a configured development database.");
  process.exitCode = 1;
} else {
  try {
    await connection.db.insert(markets).values(syntheticMarkets).onConflictDoNothing({ target: markets.slug });
    console.info("Synthetic markets added. Trading remains disabled.");
  } catch {
    console.error("Synthetic seed failed. Check database readiness and migrations.");
    process.exitCode = 1;
  } finally {
    await connection.client.end();
  }
}
