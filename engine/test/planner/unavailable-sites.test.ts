import { expect, test } from "bun:test";
import { ConfigExpressionError, ServiceTypeError } from "@lando/sdk/errors";
import { definePlugin } from "@lando/sdk/plugins";
import { LandofileShape, PluginManifest, type ServiceConfig } from "@lando/sdk/schema";
import { PluginRegistry, type ServiceType } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import { resolveLandofileForPlanning } from "../../src/planner/event-set.ts";
import { pathIsBlocked } from "../../src/planner/landofile-scopes.ts";
import { validateResolvedLandofile } from "../../src/planner/resolved-validation.ts";
import { toolingAndEventIssues } from "../../src/planner/tooling-event-issues.ts";
import * as Registry from "../../src/plugins/registry.ts";
import { compileTestLandofile } from "../compiled-landofile.ts";

const root = "/srv/unavailable-sites";

const expressionFailure = (path: readonly (string | number)[], expression = "{{ env.UNSET }}") =>
  new ConfigExpressionError({
    message: "Environment variable UNSET is not set.",
    expression,
    filePath: `${root}/.lando.yml`,
    path: [...path],
    remediation: "Set UNSET or remove the expression.",
  });

const type: ServiceType = {
  id: "partial",
  name: "partial",
  base: "l337",
  schema: Schema.Unknown,
  resolve: ({ service }) =>
    service.environment?.FAIL === "yes"
      ? Effect.fail(
          new ServiceTypeError({
            serviceType: "partial",
            message: "invalid seed",
            issues: [{ path: ["port"], message: "invalid seed" }],
            remediation: "Correct the partial service configuration, then re-run.",
          }),
        )
      : Effect.succeed({
          base: "l337",
          normalizedConfig: service,
          nonSqlCreds: { user: "user", database: "db", password: "secret" },
          features: [],
        }),
};

const plugin = definePlugin({
  name: "@test/partial",
  manifest: Schema.decodeUnknownSync(PluginManifest)({
    name: "@test/partial",
    version: "1.0.0",
    api: 4,
    entry: "index.js",
    contributes: { serviceTypes: [type.id] },
  }),
  serviceTypes: new Map([[type.id, type]]),
});

const registry = Registry.layerWith({ app: false, user: false }, [plugin]);

const resolve = (
  services: Readonly<Record<string, ServiceConfig>>,
  unavailableSites: NonNullable<Parameters<typeof resolveLandofileForPlanning>[0]["unavailableSites"]> = [],
  extra: {
    readonly networks?: LandofileShape["networks"];
    readonly proxy?: LandofileShape["proxy"];
  } = {},
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* resolveLandofileForPlanning({
        landofile: yield* compileTestLandofile(
          {
            name: "partial",
            services,
            ...(extra.networks === undefined ? {} : { networks: extra.networks }),
            ...(extra.proxy === undefined ? {} : { proxy: extra.proxy }),
          },
          root,
        ),
        pluginRegistry: yield* PluginRegistry,
        configService: undefined,
        fileSystem: undefined,
        pathsService: undefined,
        unavailableSites,
      });
    }).pipe(Effect.provide(registry)),
  );

test("pathIsBlocked covers site, ancestors, and descendants without sibling prefix false positives", () => {
  const blocked = [["networks", "b", "name"]];
  expect(pathIsBlocked(blocked, ["networks", "b", "name"])).toBe(true);
  expect(pathIsBlocked(blocked, ["networks", "b"])).toBe(true);
  expect(pathIsBlocked(blocked, ["networks", "b", "name", "x"])).toBe(true);
  expect(pathIsBlocked(blocked, ["networks", "bb", "name"])).toBe(false);
  expect(pathIsBlocked(blocked, ["networks", "a"])).toBe(false);

  const entry = [["networks", "shared"]];
  expect(pathIsBlocked(entry, ["networks", "shared", "external"])).toBe(true);
  expect(pathIsBlocked(entry, ["networks", "shared"])).toBe(true);
});

test("seeded load failure makes the service unavailable without reporting the load reason again", async () => {
  const result = await resolve(
    {
      other: { type: "partial", environment: { FOO: "raw-template" } },
      web: { type: "partial" },
    },
    [
      {
        path: ["services", "other", "environment", "FOO"],
        failure: expressionFailure(["services", "other", "environment", "FOO"]),
      },
    ],
  );
  expect(result.resolution.unavailable.has("other")).toBe(true);
  expect(result.resolution.unavailable.has("web")).toBe(false);
  expect(result._tag === "Invalid" ? result.issues : []).toEqual([]);
});

test("credential consumer of a load-blocked service is cascade-unavailable without new findings", async () => {
  const result = await resolve(
    {
      other: { type: "partial", environment: { FOO: "raw-template" } },
      web: {
        type: "partial",
        environment: { DB_USER: "{{ services.other.creds.user }}" },
      },
    },
    [
      {
        path: ["services", "other", "environment", "FOO"],
        failure: expressionFailure(["services", "other", "environment", "FOO"]),
      },
    ],
  );
  expect(result.resolution.unavailable.has("other")).toBe(true);
  expect(result.resolution.unavailable.has("web")).toBe(true);
  expect(result._tag === "Invalid" ? result.issues : []).toEqual([]);
  expect(result.resolution.endpointProjection.services.get("web")?.endpoints._tag).toBe("Unavailable");
});

test("independent service type failure still surfaces beside a load-blocked sibling", async () => {
  const result = await resolve(
    {
      other: { type: "partial", environment: { FOO: "raw-template" } },
      web: { type: "no-such-type" },
    },
    [
      {
        path: ["services", "other", "environment", "FOO"],
        failure: expressionFailure(["services", "other", "environment", "FOO"]),
      },
    ],
  );
  expect(result.resolution.unavailable.has("other")).toBe(true);
  expect(result.resolution.unavailable.has("web")).toBe(true);
  expect(result._tag).toBe("Invalid");
  if (result._tag === "Invalid") {
    expect(result.issues.some((issue) => issue.path[1] === "other")).toBe(false);
    expect(result.issues.some((issue) => issue.path[1] === "web")).toBe(true);
  }
});

test("blocked network entry is treated as declared and suppresses external+name findings", () => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    services: { web: { networks: { shared: {} } } },
    networks: { shared: { external: true, name: "shared", driver: "bridge" } },
  });
  const open = validateResolvedLandofile({
    landofile,
    landofilePath: "/app/.lando.yml",
    blocked: [],
    appSlug: "app",
  });
  expect(open.issues.some((issue) => issue.rule === "landofile.network")).toBe(true);

  const blockedField = validateResolvedLandofile({
    landofile,
    landofilePath: "/app/.lando.yml",
    blocked: [],
    loadBlocked: [["networks", "shared"]],
    appSlug: "app",
  });
  expect(blockedField.issues.filter((issue) => issue.path[0] === "networks")).toEqual([]);

  const missing = Schema.decodeUnknownSync(LandofileShape)({
    services: { web: { networks: { shared: {} } } },
  });
  const membership = validateResolvedLandofile({
    landofile: missing,
    landofilePath: "/app/.lando.yml",
    blocked: [],
    loadBlocked: [["networks", "shared"]],
    appSlug: "app",
  });
  expect(membership.issues.some((issue) => String(issue.message).includes("undeclared network"))).toBe(false);
});

test("blocked proxy entry is not reported as undeclared", () => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    services: { web: { type: "l337" } },
    proxy: { other: ["other.lndo.site"] },
  });
  const open = validateResolvedLandofile({
    landofile,
    landofilePath: "/app/.lando.yml",
    blocked: [],
    appSlug: "app",
  });
  expect(open.issues.some((issue) => String(issue.message).includes("undeclared service other"))).toBe(true);

  const blocked = validateResolvedLandofile({
    landofile,
    landofilePath: "/app/.lando.yml",
    blocked: [],
    loadBlocked: [["proxy", "other"]],
    appSlug: "app",
  });
  expect(blocked.issues.some((issue) => String(issue.message).includes("undeclared service other"))).toBe(
    false,
  );
});

test("blocked readiness.command drops probe findings at the readiness parent", () => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    services: {
      web: {
        type: "l337",
        readiness: { kind: "http", target: "host", url: "http://localhost" },
      },
    },
  });
  const open = validateResolvedLandofile({
    landofile,
    landofilePath: "/app/.lando.yml",
    blocked: [],
  });
  expect(open.issues.some((issue) => issue.path[2] === "readiness")).toBe(true);

  const blocked = validateResolvedLandofile({
    landofile,
    landofilePath: "/app/.lando.yml",
    blocked: [],
    loadBlocked: [["services", "web", "readiness", "command"]],
  });
  expect(blocked.issues.filter((issue) => issue.path[2] === "readiness")).toEqual([]);
});

test("tooling and event validators skip blocked top-level entries", async () => {
  const result = await resolve({ web: { type: "partial" } });
  const issues = toolingAndEventIssues({
    ...result.resolution,
    landofile: {
      ...result.resolution.landofile,
      events: { "never-heard-of-it": ["echo hi"], "also-unknown": ["echo"] },
    },
    blocked: [["events", "never-heard-of-it"]],
    unavailable: new Map(),
  });
  expect(issues.some((issue) => issue.path[1] === "never-heard-of-it")).toBe(false);
  expect(issues.some((issue) => issue.path[1] === "also-unknown")).toBe(true);
});
