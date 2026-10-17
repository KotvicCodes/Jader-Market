import { MemberError } from "../domain/identity";

export function appOrigin() {
  if (process.env.NODE_ENV === "production" && !process.env.APP_ORIGIN) throw new MemberError("configuration", 503);
  const url = new URL(process.env.APP_ORIGIN ?? "http://localhost:3000");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new MemberError("configuration", 503);
  return url.origin;
}

export function trustedIpHeader(value: string | undefined = process.env.AUTH_TRUSTED_IP_HEADER, environment: string | undefined = process.env.NODE_ENV) {
  const header = value?.trim();
  if (!header) {
    if (environment === "production") throw new MemberError("configuration", 503);
    return undefined;
  }
  if (!/^[a-z][a-z0-9-]{0,63}$/i.test(header)) throw new MemberError("configuration", 503);
  return header;
}
