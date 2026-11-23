// Scope and target policy.
//
// ARTEX's core safety property is that every autonomous action passes a scope gate.
// In the browser edition that gate is client-side, which makes it *advisory* against a
// determined operator — but it still keeps an honest run honest: the model cannot talk
// the agent into touching a host the user did not put in scope.
//
// Scope forms accepted in a target line or the extra-scope box:
//   app.example.com            that host plus its subdomains (a named app usually has siblings)
//   *.example.com              every subdomain of example.com (not example.com itself)
//   example.com                the host itself plus its subdomains
//   127.0.0.1                  one exact address (no neighbours)
//   10.0.0.0/24                IPv4 CIDR
//   192.168.1.10               single IP
//   example.com:8443           host with an explicit port

import type { ScopeRule } from "./types.ts";

export type ScopeParse = { ok: true; rules: ScopeRule[] } | { ok: false; error: string };

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const HOSTNAME = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?:\.(?!-)[a-z0-9-]{1,63})*$/i;
const CIDR4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\/(?:3[0-2]|[12]?\d)$/;

/** Strip a scheme, path, port and trailing dot; lowercase. "HTTPS://App.Example.com/x" → "app.example.com". */
export function normalizeHost(input: string): string {
  let v = input.trim().toLowerCase();
  if (!v) return "";
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  v = v.split("/")[0] ?? "";
  v = v.split("@").pop() ?? "";
  if (v.startsWith("[")) {
    // Bracketed IPv6 literal, optionally with a port: "[::1]:8080" → "::1".
    const end = v.indexOf("]");
    v = end === -1 ? v.slice(1) : v.slice(1, end);
  } else if ((v.match(/:/g) ?? []).length > 1) {
    // Bare IPv6 literal: every colon belongs to the address, so there is no port to strip.
    // ("::1" must not lose its tail to the port regex below.)
  } else {
    v = v.replace(/:\d+$/, "");
  }
  v = v.replace(/\.$/, "");
  return v;
}

function isIpv4(v: string): boolean {
  return IPV4.test(v);
}

/** Parse one line/item of scope. Accepts comma-separated lists too. */
export function parseScopeItem(input: string): ScopeParse {
  const rules: ScopeRule[] = [];
  const parts = input
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return { ok: false, error: "Enter at least one target." };
  }
  for (const part of parts) {
    const rule = parseOne(part);
    if (!rule) return { ok: false, error: `"${part}" is not a host, domain, IP or CIDR range.` };
    rules.push(rule);
  }
  return { ok: true, rules };
}

function parseOne(part: string): ScopeRule | null {
  // A pasted URL: keep only its host, then apply the normal host rules.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(part) || part.includes("@")) {
    const host = normalizeHost(part);
    if (!host || !host.includes(".")) return null;
    if (isIpv4(host)) return { host, raw: part };
    if (!HOSTNAME.test(host)) return null;
    return { domain: host, raw: part };
  }
  // CIDR next: it contains a slash that normalizeHost would strip.
  if (part.includes("/")) {
    const cidr = part.toLowerCase();
    if (!CIDR4.test(cidr)) return null;
    return { cidr, raw: part };
  }
  if (part.startsWith("*.")) {
    const host = normalizeHost(part.slice(2));
    if (!host || isIpv4(host) || !HOSTNAME.test(host)) return null;
    // A wildcard means "any subdomain", so the apex itself is deliberately not covered.
    return { host, wildcard: true, raw: part };
  }
  const host = normalizeHost(part);
  if (!host) return null;
  if (isIpv4(host)) return { host, raw: part };
  if (!HOSTNAME.test(host) || !host.includes(".")) {
    // Bare single labels ("localhost") are legitimate only as exact hosts.
    if (host === "localhost") return { host, raw: part };
    return null;
  }
  // A plain domain covers itself plus subdomains; anything deeper is still a domain rule,
  // which is what a pentester means by naming an application host.
  return { domain: host, raw: part };
}

function ipv4ToInt(ip: string): number {
  const octets = ip.split(".").map((o) => Number(o));
  return ((octets[0]! << 24) >>> 0) + (octets[1]! << 16) + (octets[2]! << 8) + octets[3]!;
}

function inCidr(ip: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split("/");
  if (!base || !bitsRaw) return false;
  const bits = Number(bitsRaw);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) >>> 0 === (ipv4ToInt(base) & mask) >>> 0;
}

/**
 * Is `host` covered by the rule list? Host is normalised first, so callers may pass a
 * URL host of any case.
 */
export function scopeAllows(rules: ScopeRule[], hostInput: string): boolean {
  const host = normalizeHost(hostInput);
  if (!host) return false;
  for (const rule of rules) {
    if (rule.host) {
      if (rule.host === host) return true;
      if (rule.wildcard && host.endsWith(`.${rule.host}`)) return true;
    }
    if (rule.cidr && isIpv4(host) && inCidr(host, rule.cidr)) return true;
    if (rule.domain) {
      const d = rule.domain;
      if (host === d || host.endsWith(`.${d}`)) return true;
    }
  }
  return false;
}

/** Look for a rule that names the host exactly (used for the "new host" approval prompt). */
export function exactRuleFor(rules: ScopeRule[], hostInput: string): ScopeRule | undefined {
  const host = normalizeHost(hostInput);
  return rules.find((r) => r.host === host && !r.wildcard);
}

/** Human-readable scope, e.g. ["example.com (+ subdomains)", "10.0.0.0/24"]. */
export function describeScope(rules: ScopeRule[]): string[] {
  return rules.map((r) => {
    if (r.cidr) return r.cidr;
    if (r.wildcard && r.host) return `*.${r.host}`;
    if (r.domain) return `${r.domain} (+ subdomains)`;
    return r.host ?? r.raw;
  });
}

// ── request-target policy for the raw HTTP tool ────────────────────────────────

export type RequestTargetCheck =
  | { ok: true; url: URL }
  | { ok: false; reason: string };

/**
 * Validate a URL the agent wants to request: scheme, scope, and (optionally) private
 * network literals.
 *
 * Note what a browser *cannot* do: it cannot resolve a hostname to an IP before the
 * request, so a public name that resolves to an internal address (DNS rebinding) is not
 * detectable here. The literal-IP check below still stops the obvious case:
 * "http://192.168.1.1/" never leaves for a public resolver to decide.
 */
export function checkRequestTarget(
  rawUrl: string,
  rules: ScopeRule[],
  opts: { blockPrivate: boolean },
): RequestTargetCheck {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return { ok: false, reason: "not a valid absolute URL (include http:// or https://)" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `scheme ${url.protocol} is not allowed; only http and https` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "credentials in the URL are not supported; use an Authorization header" };
  }
  const host = url.hostname;
  if (!scopeAllows(rules, host)) {
    return { ok: false, reason: `host ${host} is outside the task scope` };
  }
  if (opts.blockPrivate && isPrivateAddress(host)) {
    return {
      ok: false,
      reason: `host ${host} is a private/loopback address and "Block private ranges" is on in Settings`,
    };
  }
  return { ok: true, url };
}

/** Literal private / loopback / link-local IPv4, plus localhost names. IPv6 literals included. */
export function isPrivateAddress(hostInput: string): boolean {
  const host = normalizeHost(hostInput).replace(/^\[/, "").replace(/\]$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.includes(":")) {
    // IPv6: loopback, unspecified, unique-local and link-local are all private.
    return /^::1$/.test(host) || /^::$/.test(host) || /^(fc|fd)/i.test(host) || /^fe[89ab]/i.test(host);
  }
  if (!isIpv4(host)) return false;
  const n = ipv4ToInt(host);
  const inRange = (base: string, bits: number) => inCidr(host, `${base}/${bits}`);
  return (
    n === 0 || // 0.0.0.0/8
    inRange("10.0.0.0", 8) ||
    inRange("127.0.0.0", 8) ||
    inRange("169.254.0.0", 16) ||
    inRange("172.16.0.0", 12) ||
    inRange("192.168.0.0", 16) ||
    inRange("100.64.0.0", 10) || // CGNAT
    inRange("224.0.0.0", 4) || // multicast
    inRange("240.0.0.0", 4) // reserved
  );
}

/** Turn a user target list into a URL for the first host, defaulting to https. */
export function targetUrl(raw: string, path = "/"): string {
  const v = raw.trim();
  if (/^https?:\/\//i.test(v)) {
    try {
      new URL(v);
      return v;
    } catch {
      /* fall through */
    }
  }
  const host = normalizeHost(v);
  return `https://${host}${path.startsWith("/") ? path : `/${path}`}`;
}
