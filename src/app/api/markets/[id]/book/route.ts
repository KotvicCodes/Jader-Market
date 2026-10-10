import { memberFailure } from "../../../../../auth/web";
import { publicTradingSnapshot } from "../../../../../db/trading";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const before = new URL(request.url).searchParams.get("before") ?? undefined;
    return Response.json(await publicTradingSnapshot(id, before), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return memberFailure(error); }
}
