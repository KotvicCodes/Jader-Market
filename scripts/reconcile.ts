import "dotenv/config";
import { readFileSync, statSync } from "node:fs";
import { getDatabase } from "../src/db/client";
import { reconcileDatabase } from "../src/db/reconciliation";
import { parseExternalRegister, reconciliationExitCode } from "../src/domain/reconciliation";

try {
  const args = process.argv.slice(2);
  if (args.length===1 && args[0]==="--help") {
    console.info("Usage: npm run reconcile -- [--external-register /private/receipts.json]\nRead-only JSON report. Exit 0: complete pass; 1: discrepancies; 2: external payments unchecked; 3: unavailable/invalid input.\nSee docs/OPERATOR_RECONCILIATION.md.");
  } else {
    if (args.length!==0 && !(args.length===2 && args[0]==="--external-register" && args[1] && !args[1].startsWith("--"))) throw new Error("invalid_arguments");
    let register;
    if (args.length) {
      const file = statSync(args[1]);
      if (!file.isFile() || file.size>16*1024*1024) throw new Error("invalid_external_register");
      register = parseExternalRegister(JSON.parse(readFileSync(args[1],"utf8")));
    }
    const connection = getDatabase();
    if (!connection) throw new Error("configuration");
    const report = await reconcileDatabase(connection.db,register);
    console.info(JSON.stringify(report,null,2));
    process.exitCode = reconciliationExitCode(report.status);
  }
} catch {
  // Never log driver errors, URLs, file contents, payment references or secrets.
  console.error("Reconciliation unavailable: check arguments, private receipt register, database configuration and migrations. No clearance was issued.");
  process.exitCode = 3;
} finally {
  await getDatabase()?.client.end();
}
