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
