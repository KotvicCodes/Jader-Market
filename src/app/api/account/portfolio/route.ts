import { currentMember, memberFailure, memberResponse } from "../../../../auth/web";
import { requireMember } from "../../../../db/members";
import { portfolioSnapshot } from "../../../../db/portfolio";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const member = await currentMember();
    requireMember(member);
    const params = new URL(request.url).searchParams;
    const input: Record<string, unknown> = {};
    for (const key of params.keys()) input[key] = params.getAll(key).length === 1 ? params.get(key) : params.getAll(key);
    return memberResponse({ ...await portfolioSnapshot(member.token, input), csrf: member.csrf });
  } catch (error) { return memberFailure(error); }
}
