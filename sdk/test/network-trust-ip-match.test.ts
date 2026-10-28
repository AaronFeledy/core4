import { expect, test } from "bun:test";
import { shouldBypassProxy } from "@lando/sdk/network-trust";

test.each([
  ["localhost", true],
  ["127.0.0.1", true],
  ["127.255.254.253", true],
  ["[::1]", true],
  ["[0:0:0:0:0:0:0:1]", true],
  ["0.0.0.0", false],
  ["[::]", false],
  ["localhost.example.com", false],
  ["app.lndo.site", false],
  ["128.0.0.1", false],
] as const)("loopback bypass for %s with no patterns is %s", (host, expected) => {
  // Given a literal URL and no configured exemptions.
  const url = `http://${host}/`;
  // When the canonical bypass decision runs.
  const actual = shouldBypassProxy(url, []);
  // Then only lexical loopback endpoints bypass.
  expect(actual).toBe(expected);
});

test.each([
  ["10.2.3.4", "10.0.0.0/8", true],
  ["11.2.3.4", "10.0.0.0/8", false],
  ["192.168.1.255", "192.168.1.0/24", true],
  ["192.168.2.0", "192.168.1.0/24", false],
  ["10.2.127.255", "10.2.0.0/17", true],
  ["10.2.128.0", "10.2.0.0/17", false],
  ["10.0.0.1", "10.0.0.1/32", true],
  ["10.0.0.2", "10.0.0.1/32", false],
  ["255.255.255.255", "0.0.0.0/0", true],
  ["example.com", "0.0.0.0/0", false],
  ["[fd12::abcd]", "fd00::/8", true],
  ["[fc00::1]", "fd00::/8", false],
  ["[2001:db8:abcd::1]", "2001:db8::/32", true],
  ["[2001:db9::1]", "2001:db8::/32", false],
  ["[2001:db8:0:0:7fff::1]", "2001:db8::/65", true],
  ["[2001:db8:0:0:8000::1]", "2001:db8::/65", false],
  ["[2001:db8::1]", "2001:db8::1/128", true],
  ["[2001:db8::2]", "2001:db8::1/128", false],
  ["[ffff::1]", "::/0", true],
  ["example.com", "::/0", false],
  ["10.0.0.1", "::/0", false],
  ["[fd00::1]", "0.0.0.0/0", false],
  ["[::ffff:10.0.0.1]", "::ffff:10.0.0.0/120", true],
  ["[::ffff:10.0.1.1]", "::ffff:10.0.0.0/120", false],
  ["[::ffff:a00:1]", "::ffff:10.0.0.1", true],
  ["[fd00::1]", "fd00:0:0:0:0:0:0:1", true],
  ["[fd00::2]", "fd00::1", false],
  ["[fd00::1]", "[FD00::1]", true],
  ["[2001:db8::]", "2001:db8::", true],
  ["10.0.0.1", "10.0.0.1", true],
  ["10.0.0.2", "10.0.0.1", false],
  ["[fd00::1]", "[fd00::1]:80", true],
  ["[fd00::1]", "[fd00::1]:81", false],
  ["api.example.com", "*.example.com", true],
  ["example.com", "*.example.com", false],
  ["notexample.com", "*.example.com", false],
  ["api.example.com", "example.com:80", false],
  ["api.example.com", "  *.EXAMPLE.COM  ", true],
  ["10.0.0.1", "  10.0.0.0/8  ", true],
] as const)("matches %s against %s: %s", (host, pattern, expected) => {
  // Given a URL and a single NO_PROXY pattern.
  const url = `http://${host}/`;
  // When matching without DNS resolution.
  const actual = shouldBypassProxy(url, [pattern]);
  // Then only the literal address family or hostname rule applies.
  expect(actual).toBe(expected);
});

test.each([
  "10.0.0.0/33",
  "10.0.0.0/-1",
  "10.0.0.0/1.5",
  "10.0.0.0/",
  "10.0.0.0/8/1",
  "256.0.0.0/0",
  "10.0.0/8",
  "010.0.0.0/8",
  "example.com/0",
  "fd00::/129",
  "fd00::/-1",
  "fd00::/",
  "fd00:::1/8",
  "fd00::1::2/8",
  "gggg::/0",
  "fd00:0:0:0:0:0:0/8",
  "fd00:0:0:0:0:0:0:0:1/8",
  "fd00:0:0:0:0:0:0::1/8",
  "::ffff:999.0.0.1/0",
  "::ffff:10.0.0.1:1/0",
  "[fd00::1/8",
  "fd00::1]/8",
  "fd00::/8:80",
  "10.0.0.0/8:80",
  "fd00::/NaN",
  "fd00::/Infinity",
])("malformed pattern %s silently does not match", (pattern) => {
  // Given malformed input and non-loopback literal hosts.
  const urls = ["http://10.0.0.1/", "http://[fd00::1]/"];
  // When the public matcher parses the pattern.
  const matches = urls.map((url) => shouldBypassProxy(url, [pattern]));
  // Then no exception or exemption results.
  expect(matches).toEqual([false, false]);
});
