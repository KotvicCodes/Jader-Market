import { currentMember, memberFailure, memberResponse } from "../../../../../auth/web";
import { requireMember } from "../../../../../db/members";
import { tradingSnapshot } from "../../../../../db/trading";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const member = await currentMember();
    requireMember(member);
    const { id } = await context.params;
    const before = new URL(request.url).searchParams.get("before") ?? undefined;
    const beforeFill = new URL(request.url).searchParams.get("beforeFill") ?? undefined;
    return memberResponse(await tradingSnapshot(member.token, id, before, beforeFill));
  } catch (error) { return memberFailure(error); }
}
