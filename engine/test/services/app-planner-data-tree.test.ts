import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect";

import { rememberLandofileAppRoot } from "@lando/landofile/app-root-provenance";
import { makeLandoPaths } from "@lando/paths";
import { DataTreeOwnershipCapabilityError } from "@lando/sdk/errors";
import { LandofileShape, ServiceName } from "@lando/sdk/schema";
import { AppPlanner, PathsService } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { DATA_TREE_OWNERSHIP_STEP_ID } from "../../src/planner/data-tree.ts";
import { serviceFeatureBuildSteps } from "../../src/planner/extensions.ts";
import { PluginRegistryLive } from "../../src/plugins/registry.ts";
import { FileSystemLive } from "../../src/services/file-system.ts";
import { AppPlannerLive } from "../../src/services/planner.ts";

const capabilities = TestRuntimeProvider.capabilities;

const planEffect = (appRoot: string, landofile: LandofileShape) => {
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
    service.plan(rememberLandofileAppRoot(landofile, appRoot), capabilities),
  ).pipe(Effect.provide(planner));
};

const withAppRoot = async <T>(run: (appRoot: string) => Promise<T>): Promise<T> => {
  const root = await mkdtemp(join(tmpdir(), "lando-planner-data-tree-"));
  const appRoot = join(root, "app");
  await mkdir(appRoot, { recursive: true });
  try {
    return await run(appRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const plan = (appRoot: string, landofile: LandofileShape) =>
  Effect.runPromise(planEffect(appRoot, landofile));

const planFailure = async (appRoot: string, landofile: LandofileShape) => {
  const exit = await Effect.runPromiseExit(planEffect(appRoot, landofile));
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("Expected failure");
  return Option.getOrThrow(Cause.failureOption(exit.cause));
};

const landofile = (services: Record<string, unknown>): LandofileShape =>
  Schema.decodeUnknownSync(LandofileShape)({ name: "data-tree-app", runtime: 4, services });

const ownershipCommand = (appPlan: Awaited<ReturnType<typeof plan>>, service: string): string => {
  const plan = appPlan.services[ServiceName.make(service)];
  const step = serviceFeatureBuildSteps(plan?.extensions ?? {}).find(
    (entry) => entry.id === DATA_TREE_OWNERSHIP_STEP_ID,
  );
  if (step === undefined) return "";
  expect(step.user).toBe("root");
  expect(step.phase).toBe("build");
  return Array.isArray(step.command) ? step.command.join(" ") : String(step.command);
};

describe("Planned-user ownership of volume-backed data trees", () => {
  test("Given solr with cores under a numeric user, When planned, Then the data tree is prepared for that user", async () => {
    await withAppRoot(async (appRoot) => {
      const appPlan = await plan(
        appRoot,
        landofile({
          search: { type: "solr", cores: ["default"], user: "10001:10001", home: false },
        }),
      );
      const command = ownershipCommand(appPlan, "search");
      expect(command).toContain("mkdir -p '/var/solr'");
      expect(command).toContain("chown -R '10001' '/var/solr'");
    });
  });

  test("Given minio under a numeric user, When planned, Then the bucket tree is prepared for that user", async () => {
    await withAppRoot(async (appRoot) => {
      const appPlan = await plan(
        appRoot,
        landofile({ store: { type: "minio", user: "10001", home: false } }),
      );
      const command = ownershipCommand(appPlan, "store");
      expect(command).toContain("mkdir -p '/data'");
      expect(command).toContain("chown -R '10001' '/data'");
    });
  });

  test("Given solr with no authored user, When planned, Then no ownership step is added", async () => {
    await withAppRoot(async (appRoot) => {
      const appPlan = await plan(appRoot, landofile({ search: { type: "solr", cores: ["default"] } }));
      expect(ownershipCommand(appPlan, "search")).toBe("");
    });
  });

  test("Given solr running as the identity the image seeds, When planned, Then no ownership step is added", async () => {
    await withAppRoot(async (appRoot) => {
      const appPlan = await plan(appRoot, landofile({ search: { type: "solr", user: "solr" } }));
      expect(ownershipCommand(appPlan, "search")).toBe("");
    });
  });

  test("Given minio running as root, When planned, Then no ownership step is added", async () => {
    await withAppRoot(async (appRoot) => {
      const appPlan = await plan(appRoot, landofile({ store: { type: "minio", user: "root" } }));
      expect(ownershipCommand(appPlan, "store")).toBe("");
    });
  });

  test("Given solr running as a user the type does not declare, When planned, Then it refuses before provider action", async () => {
    await withAppRoot(async (appRoot) => {
      const failure = await planFailure(
        appRoot,
        landofile({ search: { type: "solr", cores: ["default"], user: "www-data", home: false } }),
      );
      expect(failure).toBeInstanceOf(DataTreeOwnershipCapabilityError);
      expect(failure).toMatchObject({
        _tag: "DataTreeOwnershipCapabilityError",
        service: "search",
        serviceType: "solr",
        target: "/var/solr",
        option: "services.search.user",
        user: "www-data",
      });
    });
  });

  test("Given minio running as a user the type does not declare, When planned, Then it refuses before provider action", async () => {
    await withAppRoot(async (appRoot) => {
      const failure = await planFailure(
        appRoot,
        landofile({ store: { type: "minio", user: "minio-user", home: false } }),
      );
      expect(failure).toBeInstanceOf(DataTreeOwnershipCapabilityError);
      expect(failure).toMatchObject({
        _tag: "DataTreeOwnershipCapabilityError",
        service: "store",
        target: "/data",
        option: "services.store.user",
      });
    });
  });

  test("Given a Landofile-supplied image and a named user, When planned, Then the refusal names the image option", async () => {
    await withAppRoot(async (appRoot) => {
      const failure = await planFailure(
        appRoot,
        landofile({
          search: { type: "solr", image: "example/custom-solr:1", user: "solr", home: { path: "/tmp/h" } },
        }),
      );
      expect(failure).toBeInstanceOf(DataTreeOwnershipCapabilityError);
      expect(failure).toMatchObject({ option: "services.search.image" });
    });
  });
});
