import { describe, expect, test } from "bun:test";
import { sha256Hex } from "@lando/sdk/digest";
import {
  AbsolutePath,
  PHYSICAL_VOLUME_LOCK_TIER,
  defaultRouteHostname,
  landoAppStoreName,
  landoCacheStoreName,
  landoDataRootToken,
  landoDependencyEnvironmentStoreName,
  landoNativeAppSlug,
  landoNetworkingPlan,
  landoServiceContainerName,
  landoServiceHomeStoreName,
  landoServiceShadowStoreName,
  landoServiceStorageName,
  landoServiceStoreName,
  physicalVolumeLockTier,
} from "@lando/sdk/schema";

test("global native names use the owning data root without changing DNS aliases", () => {
  const dataRoot = AbsolutePath.make("/roots/A");
  const token = sha256Hex("data-root\0/roots/A").slice(0, 16);
  const input = {
    slug: "global",
    identity: { dataRoot },
    serviceNames: ["ssh-agent"],
    sharedCrossAppNetwork: true,
  };
  const nativeSlug = landoNativeAppSlug(input);
  expect(landoDataRootToken(dataRoot)).toBe(token);
  expect(landoServiceContainerName(nativeSlug, "ssh-agent")).toBe(`lando-global-${token}--ssh-agent`);
  expect(landoNativeAppSlug({ slug: "global" })).toBe("global");
  expect(landoNetworkingPlan(input)).toMatchObject({
    perAppBridge: { name: `lando-global-${token}` },
    sharedNetworkMembership: {
      name: `lando_bridge_${token}`,
      aliases: { "ssh-agent": ["ssh-agent.global.internal"] },
    },
  });
  expect(physicalVolumeLockTier(landoServiceStoreName(nativeSlug, "a".repeat(60), "data"))).toBe(
    PHYSICAL_VOLUME_LOCK_TIER.globalApp,
  );
});

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

test.each([
  ["WEB--API", "web--api"],
  ["8.3", "8.3"],
  ["pma_theme", "pma-theme"],
  ["-Web__API-", "web-api"],
  ["a".repeat(64), "a".repeat(63)],
  ["_", sha256Hex("_").slice(0, 8)],
])("derives the default hostname for %s", (service, label) => {
  expect(defaultRouteHostname(service, "demo", "custom.test")).toBe(`${label}.demo.custom.test`);
});

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

describe("derived stores", () => {
  const serviceOwners = [landoServiceHomeStoreName, landoServiceShadowStoreName, landoServiceStorageName];
  test.each(serviceOwners)("keeps ambiguous app/service pairs distinct with %p", (owner) => {
    expect(owner("foo", "bar-web", "/data")).not.toBe(owner("foo-bar", "web", "/data"));
  });

  test("keeps generated purposes separate from roles and fallback-container stores", () => {
    const generated = pairs.flatMap(([slug, service]) =>
      serviceOwners.map((owner) => owner(slug, service, "data")),
    );
    const catalog = new Set(
      pairs.flatMap(([slug, service]) =>
        ["home", "shadow", "storage", "data"].map((role) => landoServiceStoreName(slug, service, role)),
      ),
    );
    expect(new Set(generated).size).toBe(generated.length);
    expect(generated.filter((name) => catalog.has(name))).toEqual([]);
  });

  test.each([landoServiceShadowStoreName, landoServiceStorageName])(
    "preserves exact destinations through lossy normalization with %p",
    (owner) => {
      expect(owner("app", "web", "/foo/bar")).not.toBe(owner("app", "web", "/foo-bar"));
      expect(owner("app", "web", `/${"a".repeat(90)}x`)).not.toBe(owner("app", "web", `/${"a".repeat(90)}y`));
      expect(owner("app", "web", `/${"a".repeat(47)}-/x`)).toMatch(/--[a-z]+--a{47}-[0-9a-f]{8}$/u);
    },
  );

  test("encodes home principals with bounded words and the original identity digest", () => {
    expect(landoServiceHomeStoreName("app", "web", "root")).toBe("lando-app--web--home--root-3177abf4");
    expect(landoServiceHomeStoreName("app", "a-b", "c")).toBe("lando-app--a-b--home--c-695274f6");
    expect(landoServiceHomeStoreName("app", "a", "b-c")).toBe("lando-app--a--home--b-c-02654a5c");
    expect(landoServiceHomeStoreName("app", "web", "--User A--")).toMatch(/--home--user-a-[0-9a-f]{8}$/u);
    expect(landoServiceHomeStoreName("app", "web", "a".repeat(40))).toMatch(/--home--a{32}-[0-9a-f]{8}$/u);
    expect(landoServiceHomeStoreName("app", "web")).toBe("lando-app--web--home--default");
    expect(landoServiceHomeStoreName("app", "web", "!!!")).toMatch(/--home--user-[0-9a-f]{8}$/u);
    expect(landoServiceHomeStoreName("app", "web", `${"a".repeat(31)}._B`)).toMatch(
      /--home--a{31}-[0-9a-f]{8}$/u,
    );
    expect(landoServiceHomeStoreName("app", "web", "Foo")).not.toBe(
      landoServiceHomeStoreName("app", "web", "foo"),
    );
  });

  test.each([landoCacheStoreName, (key: string) => landoAppStoreName("app", key)])(
    "separates noncanonical keys from canonical literals and long inputs with %p",
    (owner) => {
      const hash = sha256Hex("Foo").slice(0, 8);
      expect(owner("Foo")).not.toBe(owner(`foo-${hash}`));
      expect(owner("Foo")).toEndWith(`foo--${hash}`);
      expect(owner(`${"a".repeat(80)}x`)).not.toBe(owner(`${"a".repeat(80)}y`));
      expect(owner(`${"a".repeat(47)}-!`)).toMatch(/a{47}--[0-9a-f]{8}$/u);
    },
  );

  test("keeps canonical caches shared and app sources app-scoped", () => {
    expect(["nuget", "composer"].map(landoCacheStoreName)).toEqual([
      "lando-cache-nuget",
      "lando-cache-composer",
    ]);
    expect(landoAppStoreName("foo", "bar-web")).toBe("lando-foo_bar-web");
    expect(landoAppStoreName("foo", "bar-web")).not.toBe(landoAppStoreName("foo-bar", "web"));
    expect(landoAppStoreName("foo", "web")).not.toBe(landoServiceStorageName("foo", "web", "/data"));
  });
});

describe("physical volume name classification", () => {
  test("cache, ordinary and reserved global-app volume derivations occupy separate tiers", () => {
    // Given every other store-name derivation for the same short/long pairs and keys.
    const cacheKeys = [
      "composer",
      "nuget",
      "Foo",
      `${"a".repeat(80)}x`,
      `${"a".repeat(47)}-!`,
      "cache",
      "global",
      "x",
    ];
    const cacheNames = new Set(cacheKeys.map(landoCacheStoreName));
    for (const [slug, service] of [
      ...pairs,
      ["cache", "composer"],
      ["cache-composer", "abcd1234"],
      ["global", "proxy"],
      ["global", "A".repeat(80)],
    ] as const) {
      const expected =
        slug === "global" ? PHYSICAL_VOLUME_LOCK_TIER.globalApp : PHYSICAL_VOLUME_LOCK_TIER.default;
      const stores = [
        landoServiceStoreName(slug, service, "data"),
        landoServiceHomeStoreName(slug, service),
        landoServiceHomeStoreName(slug, service, "root"),
        landoServiceShadowStoreName(slug, service, "/data"),
        landoServiceStorageName(slug, service, "/data"),
        landoAppStoreName(slug, service),
        landoDependencyEnvironmentStoreName(slug, "python", "a".repeat(40)),
      ];
      for (const name of stores) expect(physicalVolumeLockTier(name), name).toBe(expected);
    }
    for (const name of cacheNames) {
      expect(physicalVolumeLockTier(name)).toBe(PHYSICAL_VOLUME_LOCK_TIER.cache);
    }
  });

  test.each([
    "lando-cache",
    "lando-cache-",
    "lando-cache--web",
    "lando-cache-foo--gggggggg",
    "lando-cache-foo--abcd12345",
    "lando-global_",
    "lando-global--proxy",
    "lando-global--proxy--",
    "lando-globals--proxy--data",
  ])("keeps non-volume namespace lookalike %s in the ordinary tier", (name) => {
    expect(physicalVolumeLockTier(name)).toBe(PHYSICAL_VOLUME_LOCK_TIER.default);
  });
});
