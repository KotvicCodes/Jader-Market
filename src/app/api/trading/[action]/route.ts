import { authorizeMutation, memberFailure, memberResponse, readBody } from "../../../../auth/web";
import { MemberError } from "../../../../domain/identity";
import { mutateTrading } from "../../../../db/trading";

export async function POST(request: Request, context: { params: Promise<{ action: string }> }) {
  try {
    const member = await authorizeMutation(request);
    const { action } = await context.params;
    if (action !== "mint" && action !== "burn" && action !== "place" && action !== "cancel") throw new MemberError("invalid_request", 404);
    return memberResponse(await mutateTrading(member.token, action, await readBody(request)));
  } catch (error) { return memberFailure(error); }
}
