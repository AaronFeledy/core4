import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect";

import { makeLandoPaths } from "@lando/paths";
import { LandofileValidationError } from "@lando/sdk/errors";
import { LandofileShape, PortablePath, ServiceName } from "@lando/sdk/schema";
import { AppPlanner, PathsService, PluginRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { literalTestLandofile } from "../compiled-landofile.ts";

import { DATA_TREE_OWNERSHIP_STEP_ID } from "../../src/planner/data-tree.ts";
import { serviceFeatureBuildSteps } from "../../src/planner/extensions.ts";
import { homeStoreName } from "../../src/planner/home.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";
import * as AppPlannerLayer from "../../src/services/planner.ts";
import {
  HOST_GATEWAY_TARGET,
  HOST_INTERNAL_ALIAS,
  HOST_IP_ENV_KEY,
} from "../../src/subsystems/networking.ts";

const capabilities = {
  ...TestRuntimeProvider.capabilities,
  artifactBuild: true,
  composeKnobs: { supported: ["tmpfs"] as const },
};

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
  test("prepares a catalog home selected implicitly by defaultUser", async () => {
    await withAppRoot(async (appRoot) => {
      const registry = Layer.effect(
        PluginRegistry,
        Effect.gen(function* () {
          const base = yield* PluginRegistry;
          return PluginRegistry.of({
            ...base,
            loadServiceType: (id) =>
              base.loadServiceType(id).pipe(
                Effect.map((type) =>
                  id === "node:22"
                    ? {
                        ...type,
                        identity: {
                          defaultUser: "node",
                          homes: { node: "/home/node" },
                          preparedHomes: ["node"],
                        },
                      }
                    : type,
                ),
              ),
          });
        }),
      ).pipe(Layer.provide(PluginRegistryLayer.layer));
      const result = await Effect.runPromise(
        Effect.flatMap(AppPlanner, (planner) =>
          planner.plan(literalTestLandofile(landofile({ web: { type: "node:22" } }), appRoot), capabilities),
        ).pipe(
          Effect.provide(
            AppPlannerLayer.layer.pipe(Layer.provide(Layer.mergeAll(registry, BunFileSystem.layer))),
          ),
        ),
      );
      const web = result.services[ServiceName.make("web")];
      expect(web?.home).toMatchObject({ state: "persisted", user: "node", target: "/home/node" });
      expect(
        serviceFeatureBuildSteps(web?.extensions ?? {}).find(
          (step) => step.id === DATA_TREE_OWNERSHIP_STEP_ID,
        )?.command,
      ).toEqual([
        "sh",
        "-c",
        "set -eu; mkdir -p '/home/node'; chown -R 'node' '/home/node'; chmod 0770 '/home/node'",
      ]);
    });
  });
  test.each([
    [{ type: "php:8.3", user: "www-data" }, "/var/www", "www-data", true],
    [{ type: "php:8.3" }, "/root", "root", false],
    [{ type: "php:8.3", user: "root" }, "/root", "root", false],
    [{ type: "node:22", user: "node" }, "/home/node", "node", false],
  ] as const)(
    "persists %j with only the required home preparation",
    async (service, target, user, prepared) => {
      await withAppRoot(async (appRoot) => {
        const result = await plan(appRoot, landofile({ web: service }));
        const web = result.services[ServiceName.make("web")];
        const store = homeStoreName(result.slug, "web", user);
        expect(web?.home).toEqual({ state: "persisted", target, store, user });
        expect(result.stores).toContainEqual({ name: store, scope: "service", kind: "data" });
        const step = serviceFeatureBuildSteps(web?.extensions ?? {}).find(
          (entry) => entry.id === DATA_TREE_OWNERSHIP_STEP_ID,
        );
        if (prepared) {
          expect(step).toMatchObject({ user: "root", phase: "build" });
          expect(step?.command).toEqual([
            "sh",
            "-c",
            "set -eu; mkdir -p '/var/www'; chown -R 'www-data' '/var/www'; chmod 0770 '/var/www'",
          ]);
        } else expect(step).toBeUndefined();
      });
    },
  );

  test.each([
    { home: false },
    { storage: [{ store: "authored", target: "/var/www" }] },
    { mounts: [".:/var/www"] },
    { appMount: "/var/www" },
    { tmpfs: ["/var/www:rw"] },
  ])("does not prepare a PHP home when persistence is declined or authored: %j", async (overrides) => {
    await withAppRoot(async (appRoot) => {
      const result = await plan(
        appRoot,
        landofile({ web: { type: "php:8.3", user: "www-data", ...overrides } }),
      );
      const web = result.services[ServiceName.make("web")];
      expect(web?.home?.state).toBe(overrides.home === false ? "disabled" : "authored");
      expect(
        serviceFeatureBuildSteps(web?.extensions ?? {}).some(
          (entry) => entry.id === DATA_TREE_OWNERSHIP_STEP_ID,
        ),
      ).toBe(false);
    });
  });

  test("rejects prepared-home planning when the provider cannot build artifacts", async () => {
    await withAppRoot(async (appRoot) => {
      const result = await Effect.runPromiseExit(
        planEffect(appRoot, landofile({ web: { type: "php:8.3", user: "www-data" } }), {
          ...capabilities,
          artifactBuild: false,
        }),
      );
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result))
        expect(Option.getOrThrow(Cause.findErrorOption(result.cause))).toMatchObject({
          _tag: "CapabilityError",
          capability: "artifactBuild",
        });
    });
  });

  test("Given a catalog type and planned user, When planned, Then one service-scoped home store is created", async () => {
    await withAppRoot(async (appRoot) => {
      const appPlan = await plan(appRoot, landofile({ web: { type: "node:22", user: "node" } }));
      const web = appPlan.services[ServiceName.make("web")];
      const store = homeStoreName(appPlan.slug, "web", "node");
      const homeMount = { store, target: PortablePath.make("/home/node"), readOnly: false };
      expect(web?.storage).toContainEqual(homeMount);
      expect(web?.storage.filter((mount) => mount.store === store)).toHaveLength(1);
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
      expect(web?.storage).toContainEqual({
        store: "keep-home",
        target: homeTarget,
        readOnly: false,
      });
      expect(web?.storage.filter((mount) => mount.target === homeTarget)).toHaveLength(1);
      expect(appPlan.stores.some((entry) => entry.name === homeStoreName(appPlan.slug, "web", "node"))).toBe(
        false,
      );
    });
  });

  test("Given a previous generated home store, When authored as storage, Then its exact runtime name is preserved", async () => {
    await withAppRoot(async (appRoot) => {
      const previous = await plan(appRoot, landofile({ web: { type: "node:22", user: "node" } }));
      const home = previous.services[ServiceName.make("web")]?.home;
      if (home?.state !== "persisted") throw new Error("Expected a persisted home");
      const next = await plan(
        appRoot,
        landofile({
          web: {
            type: "node:22",
            image: "custom/node:latest",
            appMount: false,
            storage: [{ store: home.store, target: home.target }],
          },
        }),
      );
      expect(next.services[ServiceName.make("web")]?.storage).toEqual([
        { store: home.store, target: PortablePath.make(home.target), readOnly: false },
      ]);
      expect(next.stores).toEqual([{ name: home.store, scope: "service", kind: "data" }]);
    });
  });

  test("Given a versioned catalog type, When planned, Then the pinned artifact tag does not look like a custom image", async () => {
    await withAppRoot(async (appRoot) => {
      const appPlan = await plan(appRoot, landofile({ db: { type: "mariadb:11.4" } }));
      const db = appPlan.services[ServiceName.make("db")];
      const store = homeStoreName(appPlan.slug, "db", "root");
      expect(db?.storage).toContainEqual({
        store,
        target: PortablePath.make("/root"),
        readOnly: false,
      });
      expect(db?.storage.filter((mount) => mount.store === store)).toHaveLength(1);
      expect(appPlan.stores).toContainEqual({ name: store, scope: "service", kind: "data" });
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
      const store = homeStoreName(appPlan.slug, "web");
      expect(web?.storage).toContainEqual({
        store,
        target: PortablePath.make("/home/whoami"),
        readOnly: false,
      });
      expect(web?.storage.filter((mount) => mount.store === store)).toHaveLength(1);
    });
  });

  test("Given apache running as www-data, When planned, Then one home store targets /home/www-data", async () => {
    await withAppRoot(async (appRoot) => {
      const appPlan = await plan(appRoot, landofile({ web: { type: "apache", user: "www-data" } }));
      const web = appPlan.services[ServiceName.make("web")];
      const store = homeStoreName(appPlan.slug, "web", "www-data");
      expect(web?.storage.filter((mount) => mount.store === store)).toEqual([
        { store, target: PortablePath.make("/home/www-data"), readOnly: false },
      ]);
      expect(appPlan.stores.filter((entry) => entry.name === store)).toEqual([
        { name: store, scope: "service", kind: "data" },
      ]);
    });
  });

  test.each([
    { type: "compose", image: "traefik/whoami:v1.10" },
    { type: "compose", image: "example/custom:1", home: {} },
    { type: "apache", user: "lando-nonexistent" },
    { type: "apache", image: "example/custom-httpd:1", user: "www-data" },
    { type: "compose", build: { context: "." } },
    { type: "nginx", user: "nginx" },
    { type: "static", user: "nobody" },
  ])(
    "Given an unknown home for %j, When planned, Then neither plan contains a home store",
    async (service) => {
      await withAppRoot(async (appRoot) => {
        const appPlan = await plan(appRoot, landofile({ web: service }), {
          ...capabilities,
          artifactBuild: true,
        });
        expect(appPlan.services[ServiceName.make("web")]?.home?.state).toBe("unknown");
        expect(appPlan.stores.some((entry) => entry.name.startsWith(`lando-${appPlan.slug}-web-home`))).toBe(
          false,
        );
      });
    },
  );

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
