import { cookies } from "next/headers";
import { MemberError } from "../../../../domain/identity";
import { signIn, signOut } from "../../../../db/members";
import { assertOrigin, authorizeMutation, clearSessionCookies, memberFailure, memberResponse, readBody, sessionCookie, setSessionCookies } from "../../../../auth/web";

export async function POST(request: Request, { params }: { params: Promise<{ action: string }> }) {
  try {
    assertOrigin(request);
    const { action } = await params;
    if (action === "sign-in") {
      const body = await readBody(request);
      const previousToken = (await cookies()).get(sessionCookie)?.value;
      const values = await signIn(body.handle, body.password, body.code, previousToken);
      await setSessionCookies(values);
    } else if (action === "sign-out") {
      const member = await authorizeMutation(request);
      await signOut(member.token);
      await clearSessionCookies();
    } else throw new MemberError("invalid_request", 404);
    return memberResponse({ ok: true });
  } catch (error) { return memberFailure(error); }
}
