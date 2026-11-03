import { describe, expect, test } from "bun:test";
import { landoServiceContainerName, landoServiceStoreName } from "../../src/schema/physical-names.ts";

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

const strings = (alphabet: string, maxLength: number): ReadonlyArray<string> => {
  const out: string[] = [];
  let layer = [""];
  for (let length = 1; length <= maxLength; length++) {
    layer = layer.flatMap((prefix) => [...alphabet].map((char) => prefix + char));
    out.push(...layer);
  }
  return out;
};

// Every slug producer yields lowercase words joined by single hyphens.
const slugs = strings("ab-", 4).filter((slug) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug));
const services = strings("ab-_A.", 3);
const longSlugs = ["a".repeat(40), `${"a".repeat(30)}-${"b".repeat(26)}`, "c".repeat(57)];
const longServices = [8, 20, 40, 63, 70].map((length) => "s".repeat(length));

const pairs = [
  ...slugs.flatMap((slug) => services.map((service) => [slug, service] as const)),
  ...longSlugs.flatMap((slug) =>
    [...longServices, "web", "web_1"].map((service) => [slug, service] as const),
  ),
];

describe("landoServiceContainerName", () => {
  test("gives every app and service pair its own valid DNS label", () => {
    // Given every short slug and service pair plus long names on both sides.
    const seen = new Map<string, string>();
    for (const [slug, service] of pairs) {
      // When
      const name = landoServiceContainerName(slug, service);
      // Then
      expect(name).toMatch(DNS_LABEL);
      const previous = seen.get(name);
      expect(previous, `${slug}/${service} reuses ${name}`).toBeUndefined();
      seen.set(name, `${slug}/${service}`);
    }
    expect(seen.size).toBe(pairs.length);
  });

  test.each([
    ["myapp", "web", "lando-myapp--web"],
    ["service-dns-demo", "database", "lando-service-dns-demo--database"],
  ])("joins canonical slug %s and service %s readably", (slug, service, expected) => {
    expect(landoServiceContainerName(slug, service)).toBe(expected);
  });

  test.each(["", "!!!", "My App"])("stays one DNS label for the non-canonical slug %j", (slug) => {
    for (const service of ["web", "web_1", "s".repeat(70)])
      expect(landoServiceContainerName(slug, service)).toMatch(DNS_LABEL);
  });

  test("keeps apps whose slug and service join with the same hyphens apart", () => {
    expect(landoServiceContainerName("foo", "bar-web")).not.toBe(landoServiceContainerName("foo-bar", "web"));
  });

  test("never lets a service key spell another service's fallback name", () => {
    // Given the fallback name of a service key that is not a DNS label.
    const fallback = landoServiceContainerName("foo", "web_1");
    // When another service is keyed with exactly that name's service part.
    const spelled = landoServiceContainerName("foo", fallback.slice("lando-foo--".length));
    // Then it still gets a different name.
    expect(fallback).toMatch(/^lando-foo--web-1--[0-9a-f]{8}$/u);
    expect(spelled).not.toBe(fallback);
  });
});

describe("landoServiceStoreName", () => {
  test("names each service's store after its container", () => {
    expect(landoServiceStoreName("twopg", "db1", "postgresql-data")).toBe(
      "lando-twopg--db1--postgresql-data",
    );
    expect(landoServiceStoreName("twopg", "db2", "postgresql-data")).not.toBe(
      landoServiceStoreName("twopg", "db1", "postgresql-data"),
    );
  });

  test("keeps stores of distinct services and roles apart", () => {
    const roles = ["data", "postgresql-data", "mysql-data"];
    const names = pairs.flatMap(([slug, service]) =>
      roles.map((role) => landoServiceStoreName(slug, service, role)),
    );
    expect(new Set(names).size).toBe(names.length);
  });
});
