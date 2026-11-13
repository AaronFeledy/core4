import { expect, test } from "bun:test";
import { LandofileShape } from "@lando/sdk/schema";
import { Schema } from "effect";
import { deferredSiteKey } from "../../src/planner/landofile-scopes.ts";
import { validateResolvedLandofile } from "../../src/planner/resolved-validation.ts";

const validate = (value: unknown, blocked: ReadonlySet<string> = new Set()) =>
  validateResolvedLandofile({
    landofile: Schema.decodeUnknownSync(LandofileShape)(value),
    landofilePath: "/app/.lando.yml",
    appSlug: "shop",
    blocked,
  }).issues.filter(({ rule }) => rule === "landofile.dns-name");

test.each([
  { services: { Web: {}, web: {} }, path: ["services", "web"], other: "Web" },
  {
    services: { web: {}, api: { hostnames: ["WEB"] } },
    path: ["services", "api", "hostnames", 0],
    other: "web",
  },
  {
    services: { web: {}, api: { networks: { default: { aliases: ["ok", "WEB"] } } } },
    path: ["services", "api", "networks", "default", "aliases", 1],
    other: "web",
  },
  {
    services: { web: {}, api: { networks: { default: { aliases: ["Web.Shop.Internal"] } } } },
    path: ["services", "api", "networks", "default", "aliases", 0],
    other: "web",
  },
])("rejects app-network DNS collision at $path", ({ services, path, other }) => {
  const issues = validate({ services });
  expect(issues).toHaveLength(1);
  expect(issues[0]).toMatchObject({ path, rule: "landofile.dns-name" });
  expect(issues[0]?.message).toContain(other);
  expect(issues[0]?.message).toContain("default");
});

test.each(["shared", "web.shop.internal"])("rejects authored-network collision for %s", (alias) => {
  const issues = validate({
    networks: { peer: {} },
    services: {
      web: { networks: { peer: { aliases: ["shared"] } } },
      api: { networks: { peer: { aliases: [alias.toUpperCase()] } } },
    },
  });
  expect(issues).toHaveLength(1);
  expect(issues[0]?.path).toEqual(["services", "api", "networks", "peer", "aliases", 0]);
  expect(issues[0]?.message).toContain("peer");
});

test("keeps authored networks independent and permits a service's repeated names", () => {
  expect(
    validate({
      networks: { first: {}, second: {} },
      services: {
        web: {
          hostnames: ["web"],
          networks: { default: { aliases: ["WEB"] }, first: { aliases: ["shared"] } },
        },
        api: { networks: { second: { aliases: ["shared", "web"] } } },
      },
    }),
  ).toEqual([]);
});

test.each([
  { services: { "LANDO-shop--web": {} }, path: ["services", "LANDO-shop--web"] },
  { services: { web: { hostnames: ["lando-shop--api"] } }, path: ["services", "web", "hostnames", 0] },
  {
    services: { web: { networks: { default: { aliases: ["lando-shop--api"] } } } },
    path: ["services", "web", "networks", "default", "aliases", 0],
  },
])("rejects reserved container DNS shape at $path", ({ services, path }) => {
  expect(validate({ services })).toMatchObject([{ path, rule: "landofile.dns-name" }]);
});

test("reports the reserved container DNS shape on an undeclared network", () => {
  // Given an authored alias with the reserved shape on a network the app never declares.
  // Then the reserved-shape issue is still reported; only the collision check is skipped.
  expect(
    validate({
      services: { web: { networks: { missing: { aliases: ["lando-shop--api"] } } } },
    }),
  ).toMatchObject([
    {
      path: ["services", "web", "networks", "missing", "aliases", 0],
      rule: "landofile.dns-name",
    },
  ]);
});

test("skips blocked aliases without suppressing independent DNS collisions", () => {
  expect(
    validate(
      {
        services: { web: {}, api: { hostnames: ["web", "WEB"] } },
      },
      new Set([deferredSiteKey(["services", "api", "hostnames", 0])]),
    ),
  ).toMatchObject([{ path: ["services", "api", "hostnames", 1] }]);
});

test("still reports a key collision when a field inside the service is blocked", () => {
  // Given Web's hostname depends on a value that could not be resolved.
  const issues = validate(
    { services: { Web: { hostnames: ["{{ services.bad.creds.host }}"] }, web: {} } },
    new Set([deferredSiteKey(["services", "Web", "hostnames", 0])]),
  );
  // Then the concrete keys Web and web still collide.
  expect(issues).toHaveLength(1);
  expect(issues[0]).toMatchObject({ path: ["services", "web"], rule: "landofile.dns-name" });
});

test("rejects two services whose derived container names collide", () => {
  // Given a long slug, so both keys take the hashed fallback form, and a pair whose hashes match.
  const issues = validateResolvedLandofile({
    landofile: Schema.decodeUnknownSync(LandofileShape)({
      services: { "database-96467": {}, "database-157305": {} },
    }),
    landofilePath: "/app/.lando.yml",
    appSlug: "a".repeat(57),
    blocked: new Set(),
  }).issues.filter(({ rule }) => rule === "landofile.dns-name");
  // Then the second service is reported with the shared container name.
  expect(issues).toHaveLength(1);
  expect(issues[0]).toMatchObject({ path: ["services", "database-157305"] });
  expect(issues[0]?.message).toContain("database-96467");
});
