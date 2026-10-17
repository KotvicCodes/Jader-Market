import { getDatabase } from "../../../db/client";
import { assertDatabaseReady } from "../../../db/readiness";
import { appOrigin, trustedIpHeader } from "../../../auth/configuration";
import { encryptSecret } from "../../../domain/identity";

export const dynamic = "force-dynamic";

export async function GET() {
  const connection = getDatabase();
  if (connection) {
    try {
      await assertDatabaseReady(connection.db);
      appOrigin();
      trustedIpHeader();
      encryptSecret("configuration check");
      return Response.json({ status: "ready" }, { headers: { "Cache-Control": "no-store" } });
    } catch {}
  }
  return Response.json({ status: "unavailable", code: "APPLICATION_NOT_READY" }, { status: 503, headers: { "Cache-Control": "no-store" } });
}
