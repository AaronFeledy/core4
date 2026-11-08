import { expect, test } from "bun:test";
import { CertificateName, RouteHostname, certificateNameForHostname } from "@lando/sdk/schema";
import { Schema } from "effect";

// Seeded, so every run checks the same cases; raise ROUTES locally to search wider.
const ROUTES = 2000;
const random = (() => {
  let seed = 0x1583;
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})();
const pick = (alphabet: string) => alphabet[Math.floor(random() * alphabet.length)] ?? "";
const string = (alphabet: string, min: number, max: number) =>
  Array.from({ length: min + Math.floor(random() * (max - min + 1)) }, () => pick(alphabet)).join("");

const routeLabel = () => {
  const roll = random();
  if (roll < 0.15) return "*";
  const body = string("abcdefghijklmnopqrstuvwxyz0123456789-", 0, 6);
  if (roll < 0.35) return `${pick("abc")}${body}*`;
  if (roll < 0.5) return `*${body}${pick("xyz")}`;
  return `${pick("abcdefghijklmnopqrstuvwxyz0123456789")}${body}${pick("abc0")}`;
};
const routePatterns = Array.from({ length: ROUTES }, () =>
  Array.from({ length: 1 + Math.floor(random() * 4) }, routeLabel).join("."),
).filter(Schema.is(RouteHostname));

// The proxy matches each `*` against one or more of [a-z0-9-], never across a dot.
const requestHost = (pattern: string) =>
  pattern.replaceAll("*", () => string("abcdefghijklmnopqrstuvwxyz0123456789-", 1, 4));

// TLS name matching: exact, or `*.rest` matching exactly one label in front of rest.
const covers = (name: string, host: string) =>
  name.startsWith("*.")
    ? host.slice(host.indexOf(".") + 1) === name.slice(2) && host.indexOf(".") > 0
    : name === host;

test("generated route patterns exercise both coverable and uncoverable shapes", () => {
  const mapped = routePatterns.map(certificateNameForHostname);
  expect(mapped.filter((name) => name === undefined).length).toBeGreaterThan(50);
  expect(mapped.filter((name) => name?.startsWith("*.") === true).length).toBeGreaterThan(50);
});

test("a route gets a certificate exactly when its wildcards sit in the leftmost of two or more labels", () => {
  for (const pattern of routePatterns) {
    const labels = pattern.split(".");
    const coverable =
      labels.slice(1).every((label) => !label.includes("*")) && (labels.length > 1 || !pattern.includes("*"));
    expect({ pattern, coverable: certificateNameForHostname(pattern) !== undefined }).toEqual({
      pattern,
      coverable,
    });
  }
});

test("the certificate for a route is a valid name that covers every host the route matches", () => {
  for (const pattern of routePatterns) {
    const name = certificateNameForHostname(pattern);
    if (name === undefined) continue;
    expect(Schema.is(CertificateName)(name)).toBe(true);
    for (let sample = 0; sample < 3; sample += 1) {
      const host = requestHost(pattern);
      expect({ pattern, name, host, covered: covers(name, host) }).toEqual({
        pattern,
        name,
        host,
        covered: true,
      });
    }
  }
});
