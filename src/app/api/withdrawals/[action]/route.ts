import { authorizeMutation, memberFailure, memberResponse, readBody } from "../../../../auth/web";
import { MemberError } from "../../../../domain/identity";
import { withdrawalActions, type WithdrawalAction } from "../../../../domain/withdrawals";
import { mutateWithdrawal } from "../../../../db/withdrawals";

export async function POST(request: Request, { params }: { params: Promise<{ action: string }> }) {
  try {
    const member = await authorizeMutation(request);
    const { action } = await params;
    if (!withdrawalActions.includes(action as WithdrawalAction)) throw new MemberError("invalid_request", 404);
    return memberResponse(await mutateWithdrawal(member.token, action as WithdrawalAction, await readBody(request)));
  } catch (error) { return memberFailure(error); }
}
