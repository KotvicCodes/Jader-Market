import { isIP } from "node:net";
import { MemberError } from "../domain/identity";

type Configuration = { header?: string; environment?: string };

// Only trust a header explicitly configured for a proxy that overwrites it.
// The application port must not be reachable by clients around that proxy.
export function signInClient(request: Request, configuration: Configuration = { header: process.env.AUTH_TRUSTED_IP_HEADER, environment: process.env.NODE_ENV }) {
  const header = configuration.header?.trim();
  if (!header) {
    if (configuration.environment === "production") throw new MemberError("configuration", 503);
    return "local-development";
  }
  if (!/^[a-z][a-z0-9-]{0,63}$/i.test(header)) throw new MemberError("configuration", 503);
  const address = request.headers.get(header)?.trim();
  if (!address || address.length > 45 || address.includes("%") || !isIP(address)) throw new MemberError("configuration", 503);
  if (isIP(address) === 4) return address;
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  // Map IPv4-mapped IPv6 onto the same bucket as the equivalent IPv4 address.
  const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(canonical);
  if (!mapped) return canonical;
  const value = parseInt(mapped[1], 16) * 65536 + parseInt(mapped[2], 16);
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
}
