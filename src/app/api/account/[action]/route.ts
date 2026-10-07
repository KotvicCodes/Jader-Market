import { MemberError } from "../../../../domain/identity";
import { changePassword, confirmMfa, reauthenticate, signOut, startMfa } from "../../../../db/members";
import { authorizeMutation, clearSessionCookies, memberFailure, memberResponse, readBody } from "../../../../auth/web";

export async function POST(request: Request, { params }: { params: Promise<{ action: string }> }) {
  try {
    const member = await authorizeMutation(request);
    const { action } = await params;
    const body = await readBody(request);
    if (action === "reauthenticate") await reauthenticate(member.token, body.password, body.code);
    else if (action === "mfa-start") return memberResponse({ secret: await startMfa(member.token, body.password) });
    else if (action === "mfa-confirm") await confirmMfa(member.token, body.code);
    else if (action === "password") {
      await changePassword(member.token, body.currentPassword, body.password, body.code);
      await clearSessionCookies();
    } else if (action === "sign-out-all") {
      await signOut(member.token, true);
      await clearSessionCookies();
    } else throw new MemberError("invalid_request", 404);
    return memberResponse({ ok: true });
  } catch (error) { return memberFailure(error); }
}
