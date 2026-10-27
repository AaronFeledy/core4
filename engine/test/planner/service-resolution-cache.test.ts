import { expect, test } from "bun:test";
import { LandofileShape, PortNumber, ProviderId, ServiceName } from "@lando/sdk/schema";
import type { ServiceTypeResolution } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import { deriveAppPlanCacheKey } from "../../src/cache/app-plan.ts";
import { type ResolvedService, resolvedServiceCacheInput } from "../../src/planner/service-types.ts";
import { prepareServiceComposition } from "../../src/services/feature-preparation.ts";

const creds = { user: "parent", database: "parent", password: "parent" };
const resolution: ServiceTypeResolution = {
  base: "l337",
  normalizedConfig: {},
  features: [],
  connection: { family: "postgres", port: PortNumber.make(5432), creds },
  tooling: { psql: { cmd: "psql" } },
  connectionClientNames: ["psql"],
};
const keyFor = (value: ServiceTypeResolution) => {
  const entry: ResolvedService = {
    name: "db",
    service: {},
    routes: undefined,
    authored: { byStore: new Map() },
    serviceType: {
      id: "db",
      name: "db",
      base: "l337",
      schema: Schema.Unknown,
      resolve: () => Effect.succeed(value),
    },
    resolution: value,
    logSources: [],
    prepared: prepareServiceComposition({
      base: {
        name: ServiceName.make("db"),
        type: "db",
        provider: ProviderId.make("test"),
        primary: false,
        defaultFeatures: [],
      },
      baseKind: value.base,
      appRoot: "/app",
      normalizedConfig: value.normalizedConfig,
      features: [],
    }),
    endpointContributions: [],
    applicationConfigs: new Map(),
    resolvedArtifactTag: undefined,
    envFileInputs: [],
    projectFiles: [],
    configSourceInputs: [],
  };
  return deriveAppPlanCacheKey({
    hostProvider: "test",
    appRoot: "/app",
    pluginManifests: [],
    landofile: Schema.decodeUnknownSync(LandofileShape)({ name: "cache-facts" }),
    serviceInputs: [resolvedServiceCacheInput(entry)],
  });
};

test("canonical connection facts affect cache identity even when normalized config and task bytes do not change", () => {
  const changed: ServiceTypeResolution = {
    ...resolution,
    connection: {
      family: "postgres",
      port: PortNumber.make(6543),
      creds: { user: "child", database: "child", password: "child" },
    },
  };
  expect(keyFor(changed)).not.toBe(keyFor(resolution));
});

test("non-SQL credential facts affect cache identity independently of task content", () => {
  const { connection: _connection, ...content } = resolution;
  const first = { ...content, nonSqlCreds: creds, connectionClientNames: [] };
  expect(keyFor({ ...first, nonSqlCreds: { ...creds, password: "child" } })).not.toBe(keyFor(first));
});

test("revoked authority affects cache identity even for byte-identical explicit tasks", () => {
  expect(keyFor({ ...resolution, connectionClientNames: [] })).not.toBe(keyFor(resolution));
});
