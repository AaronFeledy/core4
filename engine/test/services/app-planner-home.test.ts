import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect";

import { makeLandoPaths } from "@lando/paths";
import { HomePathCapabilityError, LandofileValidationError } from "@lando/sdk/errors";
import { LandofileShape, PortablePath, ServiceName } from "@lando/sdk/schema";
import { AppPlanner, PathsService } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { literalTestLandofile } from "../compiled-landofile.ts";

import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";
import * as AppPlannerLayer from "../../src/services/planner.ts";
import {
  HOST_GATEWAY_TARGET,
  HOST_INTERNAL_ALIAS,
  HOST_IP_ENV_KEY,
} from "../../src/subsystems/networking.ts";

const capabilities = TestRuntimeProvider.capabilities;

const planEffect = (appRoot: string, landofile: LandofileShape, providerCapabilities = capabilities) => {
  const planner = AppPlannerLayer.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        PluginRegistryLayer.layer,
        BunFileSystem.layer,
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
    service.plan(literalTestLandofile(landofile, appRoot), providerCapabilities),
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
  return Option.getOrThrow(Cause.findErrorOption(exit.cause));
};

const landofile = (services: Record<string, unknown>): LandofileShape =>
  Schema.decodeUnknownSync(LandofileShape)({ name: "home-app", runtime: 4, services });

describe("AppPlanner home persistence and host reachability", () => {
  test("Given a catalog type and planned user, When planned, Then one service-scoped home store is created", async () => {
    await withAppRoot(async (appRoot) => {
      const appPlan = await plan(appRoot, landofile({ web: { type: "node:22", user: "node" } }));
      const web = appPlan.services[ServiceName.make("web")];
      const store = `lando-${appPlan.slug}-web-home`;
      const homeMount = {
        origin: "derived" as const,
        type: "volume" as const,
        store,
        target: PortablePath.make("/home/node"),
        readOnly: false,
      };
      expect(web?.mounts).toContainEqual(homeMount);
      expect(web?.mounts.filter((mount) => mount.type === "volume" && mount.store === store)).toHaveLength(1);
      expect(appPlan.stores).toContainEqual({ name: store, scope: "service", kind: "data" });
    });
  });

  test("Given authored storage spelled with a trailing slash at the catalog home, When planned, Then the authored store is kept and no home store is stacked", async () => {
    await withAppRoot(async (appRoot) => {
      const appPlan = await plan(
        appRoot,
        landofile({
          web: {
            type: "node:22",
            user: "node",
            storage: [{ store: "keep-home", target: "/home/node/" }],
          },
        }),
      );
      const web = appPlan.services[ServiceName.make("web")];
      const homeTarget = PortablePath.make("/home/node");
      expect(web?.mounts).toContainEqual({
        type: "volume",
        store: "keep-home",
        target: homeTarget,
        origin: "authored",
        readOnly: false,
      });
      expect(web?.mounts.filter((mount) => mount.target === homeTarget)).toHaveLength(1);
      expect(appPlan.stores.some((entry) => entry.name === `lando-${appPlan.slug}-web-home`)).toBe(false);
    });
  });

  test("Given a versioned catalog type, When planned, Then the pinned artifact tag does not look like a custom image", async () => {
    await withAppRoot(async (appRoot) => {
      const appPlan = await plan(appRoot, landofile({ db: { type: "mariadb:11.4" } }));
      const db = appPlan.services[ServiceName.make("db")];
      const store = `lando-${appPlan.slug}-db-home`;
      expect(db?.mounts).toContainEqual({
        type: "volume",
        store,
        target: PortablePath.make("/root"),
        origin: "derived",
        readOnly: false,
      });
      expect(db?.mounts.filter((mount) => mount.type === "volume" && mount.store === store)).toHaveLength(1);
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
      expect(web?.mounts).toContainEqual({
        type: "volume",
        store,
        target: PortablePath.make("/home/whoami"),
        origin: "derived",
        readOnly: false,
      });
      expect(web?.mounts.filter((mount) => mount.type === "volume" && mount.store === store)).toHaveLength(1);
    });
  });

  test("Given apache running as www-data, When planned, Then one home store targets /home/www-data", async () => {
    await withAppRoot(async (appRoot) => {
      const appPlan = await plan(appRoot, landofile({ web: { type: "apache", user: "www-data" } }));
      const web = appPlan.services[ServiceName.make("web")];
      const store = `lando-${appPlan.slug}-web-home`;
      expect(
        web?.mounts.filter((mount) => mount.type === "volume").filter((mount) => mount.store === store),
      ).toEqual([
        {
          type: "volume",
          store,
          target: PortablePath.make("/home/www-data"),
          readOnly: false,
          origin: "derived",
        },
      ]);
      expect(appPlan.stores.filter((entry) => entry.name === store)).toEqual([
        { name: store, scope: "service", kind: "data" },
      ]);
    });
  });

  test("Given apache running as an undeclared user, When planned, Then HomePathCapabilityError is raised", async () => {
    await withAppRoot(async (appRoot) => {
      const failure = await planFailure(
        appRoot,
        landofile({ web: { type: "apache", user: "lando-nonexistent" } }),
      );
      expect(failure).toBeInstanceOf(HomePathCapabilityError);
      expect(failure).toMatchObject({
        _tag: "HomePathCapabilityError",
        service: "web",
        user: "lando-nonexistent",
      });
    });
  });

  test("Given apache with a custom image running as www-data, When planned, Then HomePathCapabilityError is raised", async () => {
    await withAppRoot(async (appRoot) => {
      const failure = await planFailure(
        appRoot,
        landofile({ web: { type: "apache", image: "example/custom-httpd:1", user: "www-data" } }),
      );
      expect(failure).toBeInstanceOf(HomePathCapabilityError);
      expect(failure).toMatchObject({ _tag: "HomePathCapabilityError", service: "web", user: "www-data" });
    });
  });

  test("Given an explicit home.path that is the filesystem root, When planned, Then LandofileValidationError is raised before provider action", async () => {
    await withAppRoot(async (appRoot) => {
      const failure = await planFailure(
        appRoot,
        landofile({
          web: { type: "compose", image: "traefik/whoami:v1.10", home: { path: "/" } },
        }),
      );
      expect(failure).toBeInstanceOf(LandofileValidationError);
      expect(failure).toMatchObject({
        _tag: "LandofileValidationError",
        issues: [{ path: ["services", "web", "home", "path"] }],
      });
      expect(String((failure as LandofileValidationError).message)).toContain(
        "cannot mount over the filesystem root",
      );
    });
  });

  test("Given an explicit home.path that resolves to root, When planned, Then LandofileValidationError is raised", async () => {
    await withAppRoot(async (appRoot) => {
      const failure = await planFailure(
        appRoot,
        landofile({
          web: { type: "compose", image: "traefik/whoami:v1.10", home: { path: "/data/.." } },
        }),
      );
      expect(failure).toBeInstanceOf(LandofileValidationError);
      expect(failure).toMatchObject({
        _tag: "LandofileValidationError",
        issues: [{ path: ["services", "web", "home", "path"] }],
      });
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
