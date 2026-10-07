import { authorizeMutation, memberFailure, memberResponse, readBody } from "../../../../../auth/web";
import { mutateMarket } from "../../../../../db/market-admin";
import { requireAdministrator } from "../../../../../db/members";
import { MemberError } from "../../../../../domain/identity";
import { marketActions, type MarketAction } from "../../../../../domain/market-admin";

export async function POST(request: Request, { params }: { params: Promise<{ action: string }> }) {
  try {
    const member = await authorizeMutation(request);
    requireAdministrator(member);
    const { action } = await params;
    if (!marketActions.includes(action as MarketAction)) throw new MemberError("invalid_request", 404);
    const body = await readBody(request, 16_384);
    const result = await mutateMarket(member.token, action as MarketAction, body);
    return memberResponse({ ok: true, ...result }, action === "create" ? 201 : 200);
  } catch (error) { return memberFailure(error); }
}
