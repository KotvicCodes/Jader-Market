import { currentMember, memberFailure, memberResponse } from "../../../../auth/web";
import { requireMember } from "../../../../db/members";
import { payoutHistory } from "../../../../db/settlement";
import { parseMarketQuery } from "../../../../domain/market-query";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const member = await currentMember();
    requireMember(member);
    const page = parseMarketQuery({ page: new URL(request.url).searchParams.get("page") ?? undefined }).page;
    const history = await payoutHistory(member.token, page);
    return memberResponse({ ...history, items: history.items.map(p => ({ ...p, quantity: p.quantity.toString(), amount: p.amount.toString(), createdAt: p.createdAt.toISOString() })) });
  } catch (error) { return memberFailure(error); }
}
