import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Schema } from "effect";

import { LandofileValidationError } from "@lando/core/errors";
import {
  AppPlan,
  type LandofileShape,
  PortablePath,
  type ProviderCapabilities,
  ProviderId,
  ServiceName,
} from "@lando/core/schema";
import { AppPlanner } from "@lando/core/services";
import { PluginRegistryLive } from "../../src/plugins/registry.ts";
import { AppPlannerLive } from "../../src/services/planner.ts";

const providerLandoCapabilities: ProviderCapabilities = {
  artifactBuild: true,
  artifactPull: true,
  buildSecrets: true,
  buildSsh: true,
  multiServiceApply: true,
  serviceExec: true,
  serviceLogs: true,
  serviceHealth: "native",
  hostReachability: "native",
  sharedCrossAppNetwork: true,
  persistentStorage: true,
  bindMounts: true,
  bindMountPerformance: "native",
  copyMounts: true,
  hostPortPublish: "native",
  routeProvider: true,
  tlsCertificates: "lando",
  rootless: true,
  privilegedServices: false,
  composeSpec: "native",
  providerExtensions: ["compose", "labels", "registryCredentials"],
};

const slowBindMountCapabilities: ProviderCapabilities = {
  ...providerLandoCapabilities,
  bindMountPerformance: "slow",
};

const landofileFixture: LandofileShape = {
  name: "myapp",
  runtime: 4,
  services: {
    [ServiceName.make("web")]: {
      image: "node:lts",
      ports: ["3000:3000"],
      environment: { NODE_ENV: "development" },
      dependsOn: ["db"],
    },
    [ServiceName.make("db")]: {
      image: "postgres:16",
      ports: ["5432:5432"],
      environment: { POSTGRES_PASSWORD: "lando" },
    },
  },
};

const withTempCwd = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-app-planner-")));
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    return await run(dir);
  } finally {
    process.chdir(previousCwd);
    await rm(dir, { recursive: true, force: true });
  }
};

const plan = (landofile: LandofileShape, providerCapabilities = providerLandoCapabilities) =>
  Effect.runPromise(
    Effect.flatMap(AppPlanner, (appPlanner) => appPlanner.plan(landofile, providerCapabilities)).pipe(
      Effect.provide(AppPlannerLive),
      Effect.provide(PluginRegistryLive),
    ),
  );

const planExit = (landofile: LandofileShape, providerCapabilities = providerLandoCapabilities) =>
  Effect.runPromiseExit(
    Effect.flatMap(AppPlanner, (appPlanner) => appPlanner.plan(landofile, providerCapabilities)).pipe(
      Effect.provide(AppPlannerLive),
      Effect.provide(PluginRegistryLive),
    ),
  );

describe("AppPlannerLive", () => {
  test("plans a Node and Postgres Landofile into a schema-valid AppPlan", async () => {
    await withTempCwd(async (appRoot) => {
      const appPlan = await plan(landofileFixture);

      const encoded = Schema.encodeSync(AppPlan)(appPlan);
      expect(Schema.decodeUnknownEither(AppPlan)(encoded)._tag).toBe("Right");
      expect(appPlan.provider).toBe(ProviderId.make("lando"));
      expect(Object.keys(appPlan.services).sort()).toEqual(["db", "web"]);

      const web = appPlan.services[ServiceName.make("web")];
      const db = appPlan.services[ServiceName.make("db")];

      expect(web?.type).toBe("node:lts");
      expect(web?.artifact).toEqual({ kind: "ref", ref: "node:lts" });
      expect(web?.environment).toEqual({ NODE_ENV: "development" });
      expect(String(web?.workingDirectory)).toBe("/app");
      expect(web?.mounts).toContainEqual({
        type: "bind",
        source: appRoot,
        target: PortablePath.make("/app"),
        readOnly: false,
        realization: "passthrough",
      });
      expect(web?.endpoints).toEqual([{ port: 3000, protocol: "http", name: "web" }]);
      expect(web?.dependsOn).toEqual([{ service: ServiceName.make("db"), condition: "started" }]);

      expect(db?.type).toBe("postgres");
      expect(db?.artifact).toEqual({ kind: "ref", ref: "postgres:16" });
      expect(db?.environment.POSTGRES_USER).toBe("lando");
      expect(db?.environment.POSTGRES_DB?.startsWith("lando-app-planner-")).toBe(true);
      expect(db?.environment.POSTGRES_PASSWORD).toBe("lando");
      expect(db?.endpoints).toEqual([{ port: 5432, protocol: "tcp", name: "db" }]);
      expect(db?.storage[0]?.target).toBe(PortablePath.make("/var/lib/postgresql/data"));
    });
  });

  test("keeps slow provider bind mounts as passthrough instead of accelerated volumes", async () => {
    await withTempCwd(async () => {
      const appPlan = await plan(landofileFixture, slowBindMountCapabilities);
      const web = appPlan.services[ServiceName.make("web")];

      expect(web?.mounts).toContainEqual({
        type: "bind",
        source: process.cwd(),
        target: PortablePath.make("/app"),
        readOnly: false,
        realization: "passthrough",
      });
      expect(web?.mounts.some((mount) => mount.type === "volume")).toBe(false);
    });
  });

  test("fails unknown service types with LandofileValidationError", async () => {
    await withTempCwd(async () => {
      const exit = await planExit({
        name: "myapp",
        runtime: 4,
        services: {
          [ServiceName.make("cache")]: {
            type: "redis",
            image: "redis:7",
          },
        },
      });

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(LandofileValidationError);
          expect(failure.value._tag).toBe("LandofileValidationError");
          if (failure.value instanceof LandofileValidationError) {
            expect(failure.value.issues).toEqual(["services.cache.type"]);
          }
        }
      }
    });
  });
});
