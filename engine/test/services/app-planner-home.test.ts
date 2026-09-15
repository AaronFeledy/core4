import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect";

import { rememberLandofileAppRoot } from "@lando/landofile/app-root-provenance";
import { makeLandoPaths } from "@lando/paths";
import { HomePathCapabilityError } from "@lando/sdk/errors";
import { LandofileShape, PortablePath, ServiceName } from "@lando/sdk/schema";
import { AppPlanner, PathsService } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { PluginRegistryLive } from "../../src/plugins/registry.ts";
import { FileSystemLive } from "../../src/services/file-system.ts";
import { AppPlannerLive } from "../../src/services/planner.ts";
import {
  HOST_GATEWAY_TARGET,
  HOST_INTERNAL_ALIAS,
  HOST_IP_ENV_KEY,
} from "../../src/subsystems/networking.ts";

const capabilities = TestRuntimeProvider.capabilities;

const planEffect = (appRoot: string, landofile: LandofileShape, providerCapabilities = capabilities) => {
  const planner = AppPlannerLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        PluginRegistryLive,
        FileSystemLive,
        Layer.succeed(
          PathsService,
          makeLandoPaths({
            platform: "linux",
            home: appRoot,
            env: {},
            userCacheRoot: join(appRoot, "cache"),
          }),
        ),
      ),
    ),
  );
  return Effect.flatMap(AppPlanner, (service) =>
    service.plan(rememberLandofileAppRoot(landofile, appRoot), providerCapabilities),
  ).pipe(Effect.provide(planner));
};

const withAppRoot = async <T>(run: (appRoot: string) => Promise<T>): Promise<T> => {
  const root = await mkdtemp(join(tmpdir(), "lando-planner-home-"));
  const appRoot = join(root, "app");
  await mkdir(appRoot, { recursive: true });
  try {
    return await run(appRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const plan = (appRoot: string, landofile: LandofileShape, providerCapabilities = capabilities) =>
  Effect.runPromise(planEffect(appRoot, landofile, providerCapabilities));

const planFailure = async (appRoot: string, landofile: LandofileShape) => {
  const exit = await Effect.runPromiseExit(planEffect(appRoot, landofile));
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("Expected failure");
  return Option.getOrThrow(Cause.failureOption(exit.cause));
};

const landofile = (services: Record<string, unknown>): LandofileShape =>
  Schema.decodeUnknownSync(LandofileShape)({ name: "home-app", runtime: 4, services });

describe("AppPlanner home persistence and host reachability", () => {
  test("Given a catalog type and planned user, When planned, Then one service-scoped home store is created", async () => {
    await withAppRoot(async (appRoot) => {
      const appPlan = await plan(appRoot, landofile({ web: { type: "node:22", user: "node" } }));
      const web = appPlan.services[ServiceName.make("web")];
      const store = `lando-${appPlan.slug}-web-home`;
      const homeMount = { store, target: PortablePath.make("/home/node"), readOnly: false };
      expect(web?.storage).toContainEqual(homeMount);
      expect(web?.storage.filter((mount) => mount.store === store)).toHaveLength(1);
      expect(appPlan.stores).toContainEqual({ name: store, scope: "service", kind: "data" });
    });
  });

  test("Given a versioned catalog type, When planned, Then the pinned artifact tag does not look like a custom image", async () => {
    await withAppRoot(async (appRoot) => {
      const appPlan = await plan(appRoot, landofile({ db: { type: "mariadb:11.4" } }));
      const db = appPlan.services[ServiceName.make("db")];
      const store = `lando-${appPlan.slug}-db-home`;
      expect(db?.storage).toContainEqual({
        store,
        target: PortablePath.make("/root"),
        readOnly: false,
      });
      expect(db?.storage.filter((mount) => mount.store === store)).toHaveLength(1);
    });
  });

  test("Given a compose image without a home path, When planned, Then HomePathCapabilityError is raised before provider action", async () => {
    await withAppRoot(async (appRoot) => {
      const failure = await planFailure(
        appRoot,
        landofile({ web: { type: "compose", image: "traefik/whoami:v1.10" } }),
      );
      expect(failure).toBeInstanceOf(HomePathCapabilityError);
      expect(failure).toMatchObject({
        _tag: "HomePathCapabilityError",
        service: "web",
        remediation: expect.stringContaining("services.web.home: false"),
      });
    });
  });

  test("Given an explicit home.path on a custom image, When planned, Then that destination is the generated store", async () => {
    await withAppRoot(async (appRoot) => {
      const appPlan = await plan(
        appRoot,
        landofile({
          web: { type: "compose", image: "traefik/whoami:v1.10", home: { path: "/home/whoami" } },
        }),
      );
      const web = appPlan.services[ServiceName.make("web")];
      const store = `lando-${appPlan.slug}-web-home`;
      expect(web?.storage).toContainEqual({
        store,
        target: PortablePath.make("/home/whoami"),
        readOnly: false,
      });
      expect(web?.storage.filter((mount) => mount.store === store)).toHaveLength(1);
    });
  });

  test("Given apache running as www-data, When planned, Then it refuses rather than inventing a home", async () => {
    await withAppRoot(async (appRoot) => {
      const failure = await planFailure(appRoot, landofile({ web: { type: "apache", user: "www-data" } }));
      expect(failure).toBeInstanceOf(HomePathCapabilityError);
      expect(failure).toMatchObject({ _tag: "HomePathCapabilityError", service: "web", user: "www-data" });
    });
  });

  test("Given emulated host reachability, When planned, Then the alias and LANDO_HOST_IP are realized", async () => {
    await withAppRoot(async (appRoot) => {
      const appPlan = await plan(appRoot, landofile({ web: { type: "node:22", user: "node" } }));
      const web = appPlan.services[ServiceName.make("web")];
      expect(web?.environment[HOST_IP_ENV_KEY]).toBe(HOST_INTERNAL_ALIAS);
      expect(web?.hostAliases).toContainEqual({ hostname: HOST_INTERNAL_ALIAS, ip: HOST_GATEWAY_TARGET });
    });
  });

  test("Given a provider that cannot reach the host, When planned, Then neither alias nor LANDO_HOST_IP exist", async () => {
    await withAppRoot(async (appRoot) => {
      const appPlan = await plan(appRoot, landofile({ web: { type: "node:22", user: "node" } }), {
        ...capabilities,
        hostReachability: "none",
      });
      const web = appPlan.services[ServiceName.make("web")];
      expect(HOST_IP_ENV_KEY in (web?.environment ?? {})).toBe(false);
      expect(web?.hostAliases.some((alias) => alias.hostname === HOST_INTERNAL_ALIAS)).toBe(false);
    });
  });
});
