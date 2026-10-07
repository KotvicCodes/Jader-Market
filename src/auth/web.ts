import { cookies } from "next/headers";
import { timingSafeEqual } from "node:crypto";
import { digest, MemberError } from "../domain/identity";
import { readSession, requireMember, takeRateLimit } from "../db/members";

export const sessionCookie = "jader_session";
export const csrfCookie = "jader_csrf";

export function appOrigin() {
  const url = new URL(process.env.APP_ORIGIN ?? "http://localhost:3000");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new MemberError("configuration", 503);
  return url.origin;
}

export function assertOrigin(request: Request) {
  if (request.headers.get("origin") !== appOrigin()) throw new MemberError("invalid_origin", 403);
}

export async function readBody(request: Request, maximumBytes = 4096): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new MemberError("invalid_request");
  const reader = request.body?.getReader();
  if (!reader) throw new MemberError("invalid_request");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maximumBytes) { await reader.cancel(); throw new MemberError("invalid_request", 413); }
    chunks.push(value);
  }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new MemberError("invalid_request"); }
  if (!body || Array.isArray(body) || typeof body !== "object") throw new MemberError("invalid_request");
  return body as Record<string, unknown>;
}

export async function currentMember() {
  const jar = await cookies();
  const token = jar.get(sessionCookie)?.value;
  if (!token) return undefined;
  const session = await readSession(token);
  return session ? { ...session, token, csrf: jar.get(csrfCookie)?.value ?? "" } : undefined;
}

export async function authorizeMutation(request: Request) {
  assertOrigin(request);
  const member = await currentMember();
  requireMember(member);
  const csrf = request.headers.get("x-csrf-token");
  if (!csrf || csrf.length > 128 || !timingSafeEqual(Buffer.from(digest(csrf)), Buffer.from(member.csrfHash))) throw new MemberError("invalid_csrf", 403);
  await takeRateLimit("member_mutation", member.tokenHash, 60, 60_000);
  return member;
}

export async function setSessionCookies(values: { token: string; csrf: string }) {
  const jar = await cookies();
  const options = { httpOnly: true, sameSite: "strict" as const, secure: appOrigin().startsWith("https:"), path: "/", maxAge: 24 * 60 * 60 };
  jar.set(sessionCookie, values.token, options);
  jar.set(csrfCookie, values.csrf, options);
}

export async function clearSessionCookies() {
  const jar = await cookies();
  jar.delete(sessionCookie);
  jar.delete(csrfCookie);
}

export function memberResponse(data: Record<string, unknown> = {}, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store, private" } });
}

export function memberFailure(error: unknown) {
  return error instanceof MemberError ? memberResponse({ error: error.code }, error.status) : memberResponse({ error: "unavailable" }, 503);
}
