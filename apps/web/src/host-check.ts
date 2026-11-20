/**
 * DNS-rebinding guard. A page on another site can point its own hostname at
 * 127.0.0.1 and then talk to Daedalus from the victim's browser; the browser
 * still sends that hostname in the Host header. Only exact loopback names on
 * our own port are accepted. See docs/decisions/0006-host-header-allowlist.md.
 */
export const ALLOWED_HOSTNAMES = ["127.0.0.1", "localhost"] as const;

export function isAllowedHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const value = host.toLowerCase();
  return ALLOWED_HOSTNAMES.some((name) => value === `${name}:${port}`);
}
