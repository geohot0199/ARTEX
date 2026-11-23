import assert from "node:assert/strict";
import test from "node:test";

import {
  checkRequestTarget,
  describeScope,
  isPrivateAddress,
  normalizeHost,
  parseScopeItem,
  scopeAllows,
  targetUrl,
} from "../lib/scope.ts";
import type { ScopeRule } from "../lib/types.ts";

function rules(...items: string[]): ScopeRule[] {
  const out: ScopeRule[] = [];
  for (const item of items) {
    const parsed = parseScopeItem(item);
    assert.equal(parsed.ok, true, `${item} should parse: ${parsed.ok ? "" : parsed.error}`);
    if (parsed.ok) out.push(...parsed.rules);
  }
  return out;
}

test("normalizeHost strips scheme, path, port and trailing dots", () => {
  assert.equal(normalizeHost("https://Example.com/path?q=1"), "example.com");
  assert.equal(normalizeHost("EXAMPLE.com:8443"), "example.com");
  assert.equal(normalizeHost("example.com."), "example.com");
  assert.equal(normalizeHost("  example.com  "), "example.com");
});

test("parseScopeItem accepts hosts, wildcards, CIDRs and URLs", () => {
  const host = parseScopeItem("app.example.com");
  assert.equal(host.ok, true);
  assert.equal(host.ok && host.rules[0]?.domain, "app.example.com");

  const ip = parseScopeItem("127.0.0.1");
  assert.equal(ip.ok, true);
  assert.equal(ip.ok && ip.rules[0]?.host, "127.0.0.1");

  const wildcard = parseScopeItem("*.example.com");
  assert.equal(wildcard.ok, true);
  assert.equal(wildcard.ok && wildcard.rules[0]?.host, "example.com");
  assert.equal(wildcard.ok && wildcard.rules[0]?.wildcard, true);

  const cidr = parseScopeItem("10.0.0.0/24");
  assert.equal(cidr.ok, true);
  assert.equal(cidr.ok && cidr.rules[0]?.cidr, "10.0.0.0/24");

  const url = parseScopeItem("https://shop.example.com:443/cart");
  assert.equal(url.ok, true);
  assert.equal(url.ok && url.rules[0]?.domain, "shop.example.com");
});

test("parseScopeItem rejects nonsense", () => {
  for (const bad of ["", "   ", "not a host", "10.0.0.0/99", "http://"]) {
    const parsed = parseScopeItem(bad);
    assert.equal(parsed.ok, false, `${JSON.stringify(bad)} should be rejected`);
  }
});

test("wildcards match the domain and its subdomains but not lookalikes", () => {
  const r = rules("*.example.com");
  assert.equal(scopeAllows(r, "example.com"), true);
  assert.equal(scopeAllows(r, "www.example.com"), true);
  assert.equal(scopeAllows(r, "a.b.example.com"), true);
  assert.equal(scopeAllows(r, "notexample.com"), false);
  assert.equal(scopeAllows(r, "example.com.evil.net"), false);
});

test("a named host covers itself and its subdomains, and nothing beside it", () => {
  const r = rules("app.example.com");
  assert.equal(scopeAllows(r, "app.example.com"), true);
  assert.equal(scopeAllows(r, "APP.example.com:443"), true);
  assert.equal(scopeAllows(r, "admin.app.example.com"), true, "subdomains of a named host are in scope");
  assert.equal(scopeAllows(r, "example.com"), false);
  assert.equal(scopeAllows(r, "notapp.example.com"), false);
});

test("an IP rule is exact and does not widen to the /24", () => {
  const r = rules("192.168.1.10");
  assert.equal(scopeAllows(r, "192.168.1.10"), true);
  assert.equal(scopeAllows(r, "192.168.1.11"), false);
});

test("normalizeHost keeps IPv6 literals intact", () => {
  assert.equal(normalizeHost("::1"), "::1");
  assert.equal(normalizeHost("[::1]:8080"), "::1");
  assert.equal(normalizeHost("[fd00::1]"), "fd00::1");
});

test("CIDR rules match literal addresses inside the range only", () => {
  const r = rules("192.168.1.0/24");
  assert.equal(scopeAllows(r, "192.168.1.7"), true);
  assert.equal(scopeAllows(r, "192.168.1.0"), true);
  assert.equal(scopeAllows(r, "192.168.2.7"), false);
  assert.equal(scopeAllows(r, "10.0.0.1"), false);
  assert.equal(scopeAllows(r, "example.com"), false, "a name is never matched by a CIDR rule");
});

test("an empty scope allows nothing", () => {
  assert.equal(scopeAllows([], "example.com"), false);
});

test("checkRequestTarget enforces scheme, scope and private ranges", () => {
  const r = rules("*.example.com", "127.0.0.1");

  const good = checkRequestTarget("https://www.example.com/x", r, { blockPrivate: true });
  assert.equal(good.ok, true);

  const outOfScope = checkRequestTarget("https://evil.net/", r, { blockPrivate: false });
  assert.equal(outOfScope.ok, false);
  assert.equal(outOfScope.ok === false && /outside the task scope/.test(outOfScope.reason), true);

  const badScheme = checkRequestTarget("file:///etc/passwd", r, { blockPrivate: false });
  assert.equal(badScheme.ok, false);

  const garbage = checkRequestTarget("example.com", r, { blockPrivate: false });
  assert.equal(garbage.ok, false);

  const creds = checkRequestTarget("https://user:pass@www.example.com/", r, { blockPrivate: false });
  assert.equal(creds.ok, false);

  // In scope, but private ranges are switched on.
  const blocked = checkRequestTarget("http://127.0.0.1:8080/", r, { blockPrivate: true });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.ok === false && /private\/loopback/.test(blocked.reason), true);

  // Same URL is fine when the operator turned the guard off.
  assert.equal(checkRequestTarget("http://127.0.0.1:8080/", r, { blockPrivate: false }).ok, true);
});

test("isPrivateAddress covers loopback, RFC1918, link-local and localhost names", () => {
  for (const host of [
    "localhost",
    "api.localhost",
    "127.0.0.1",
    "127.9.9.9",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "fd00::1",
    "fe80::1",
  ]) {
    assert.equal(isPrivateAddress(host), true, host);
  }
  for (const host of ["8.8.8.8", "172.32.0.1", "example.com", "1.1.1.1"]) {
    assert.equal(isPrivateAddress(host), false, host);
  }
});

test("targetUrl defaults to https and keeps an explicit scheme", () => {
  assert.equal(targetUrl("example.com"), "https://example.com/");
  assert.equal(targetUrl("example.com", "/login"), "https://example.com/login");
  assert.equal(targetUrl("http://example.com/x"), "http://example.com/x");
});

test("describeScope yields one readable line per rule", () => {
  const lines = describeScope(rules("*.example.com", "acme.test", "10.0.0.0/24"));
  assert.equal(lines.length, 3);
  assert.ok(lines.some((l) => l.includes("example.com")));
});
