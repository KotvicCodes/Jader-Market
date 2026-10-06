import { getDatabase } from "../../../db/client";

export const dynamic = "force-dynamic";

export async function GET() {
  const connection = getDatabase();
  if (connection) {
    try {
      await connection.client`select id from markets limit 1`;
      return Response.json({ status: "ready" }, { headers: { "Cache-Control": "no-store" } });
    } catch {}
  }
  return Response.json({ status: "unavailable", code: "DATABASE_NOT_READY" }, { status: 503, headers: { "Cache-Control": "no-store" } });
}
