import { currentMember, memberFailure, memberResponse } from "../../../../../auth/web";
import { marketSnapshot } from "../../../../../db/market-snapshot";

export const dynamic = "force-dynamic";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    return memberResponse(await marketSnapshot(id, await currentMember()));
  } catch (error) { return memberFailure(error); }
}
