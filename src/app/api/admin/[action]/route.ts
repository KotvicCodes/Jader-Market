import { MemberError } from "../../../../domain/identity";
import { adjustCredits, createParticipant, manageParticipant, requireAdministrator } from "../../../../db/members";
import { authorizeMutation, memberFailure, memberResponse, readBody } from "../../../../auth/web";

export async function POST(request: Request, { params }: { params: Promise<{ action: string }> }) {
  try {
    const member = await authorizeMutation(request);
    requireAdministrator(member);
    const { action } = await params;
    const body = await readBody(request);
    if (action === "create-account") {
      const id = await createParticipant(member.token, body.handle, body.password);
      return memberResponse({ ok: true, id }, 201);
    } else if (action === "credits") {
      const id = await adjustCredits(member.token, { recipientId: body.recipientId, amount: body.amount, kind: body.kind, reason: body.reason, operationKey: body.operationKey, confirmed: body.confirmed });
      return memberResponse({ ok: true, id });
    } else if (["suspend", "resume", "reset-password"].includes(action)) {
      if (body.confirmed !== true) throw new MemberError("invalid_request");
      await manageParticipant(member.token, body.targetId, action as "suspend" | "resume" | "reset-password", body.password);
    } else throw new MemberError("invalid_request", 404);
    return memberResponse({ ok: true });
  } catch (error) { return memberFailure(error); }
}
