import { describe, expect, test } from "bun:test";
import { sha256Hex } from "@lando/sdk/digest";
import {
  LandofileShape,
  PortablePath,
  type ServiceConfig,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import type { ServiceType, ServiceTypeProjectFileInput } from "@lando/sdk/services";
import { Schema } from "effect";

import {
  NODE_FEATURE_ID,
  NODE_PACKAGE_CACHE,
  NODE_PACKAGE_CACHE_PATHS,
  NODE_PACKAGE_CACHE_PREPARE,
  NODE_PACKAGE_CACHE_STEP_ID,
  NODE_PACKAGE_CACHE_TARGET,
  node22ServiceType,
  nodePackageCacheEnvironment,
  nodeServiceFeature,
} from "../src/services/node.ts";
import {
  type NodePackageManagerConfig,
  PACKAGE_MANAGER_LAUNCHER_REVISION,
} from "../src/services/node-package-manager.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const metadata = {
  resolvedAt: "2026-11-23T00:00:00Z",
  source: "/srv/apps/node-cache/.lando.yml",
  runtime: 4 as const,
};

const BuildSteps = Schema.Struct({
  buildSteps: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.optionalKey(Schema.String),
        phase: Schema.optionalKey(Schema.String),
        command: Schema.Unknown,
        user: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
});

const present = (path: string, text: string): ServiceTypeProjectFileInput => ({
  path,
  present: true,
  text,
  sha256: sha256Hex(text),
});

const packageJson = (value: Record<string, unknown>): ServiceTypeProjectFileInput =>
  present("package.json", JSON.stringify(value));

const decodeService = (raw: unknown): ServiceConfig => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "node-cache",
    services: { web: raw },
  });
  const service = landofile.services?.[ServiceName.make("web")];
  if (service === undefined) throw new Error("web service missing");
  return service;
};

const composeNodePlan = (
  raw: Record<string, unknown>,
  projectFiles: ReadonlyArray<ServiceTypeProjectFileInput> = [],
  serviceType: ServiceType = node22ServiceType,
): Promise<ServicePlan> =>
  composeServicePlan({
    serviceType,
    service: decodeService({ type: serviceType.id, ...raw }),
    appRoot: "/srv/apps/node-cache",
    appName: "node-cache",
    serviceName: "web",
    metadata,
    featureOverrides: new Map([[NODE_FEATURE_ID, nodeServiceFeature]]),
    projectFiles,
  });

const buildStepsFor = (plan: ServicePlan) =>
  Schema.decodeUnknownSync(BuildSteps)(plan.extensions["@lando/core/service-features"]).buildSteps ?? [];

const cacheMount = (plan: ServicePlan) =>
  plan.mounts.filter((mount) => mount.target === NODE_PACKAGE_CACHE_TARGET);

const manager = (name: "pnpm" | "yarn", version: string): NodePackageManagerConfig => ({
  name,
  version,
  sourcePath: "package.json",
  sourceField: "packageManager",
  launcher: PACKAGE_MANAGER_LAUNCHER_REVISION,
});

describe("nodePackageCacheEnvironment", () => {
  test("sets npm_config_cache when the user has not", () => {
    expect(nodePackageCacheEnvironment(undefined, undefined)).toEqual({
      npm_config_cache: NODE_PACKAGE_CACHE_PATHS.npm,
    });
  });

  test("leaves a user-set npm_config_cache alone", () => {
    expect(nodePackageCacheEnvironment({ npm_config_cache: "/tmp/npm" }, undefined)).toEqual({});
  });

  test("uses npm_config_store_dir for pnpm 10 and pnpm_config_store_dir for pnpm 11", () => {
    expect(nodePackageCacheEnvironment(undefined, manager("pnpm", "10.15.0"))).toEqual({
      npm_config_cache: NODE_PACKAGE_CACHE_PATHS.npm,
      npm_config_store_dir: NODE_PACKAGE_CACHE_PATHS.pnpm,
    });
    expect(nodePackageCacheEnvironment(undefined, manager("pnpm", "11.0.0"))).toEqual({
      npm_config_cache: NODE_PACKAGE_CACHE_PATHS.npm,
      pnpm_config_store_dir: NODE_PACKAGE_CACHE_PATHS.pnpm,
    });
  });

  test("uses YARN_CACHE_FOLDER for Yarn classic and YARN_GLOBAL_FOLDER for Berry", () => {
    expect(nodePackageCacheEnvironment(undefined, manager("yarn", "1.22.22"))).toEqual({
      npm_config_cache: NODE_PACKAGE_CACHE_PATHS.npm,
      YARN_CACHE_FOLDER: NODE_PACKAGE_CACHE_PATHS.yarn,
    });
    expect(nodePackageCacheEnvironment(undefined, manager("yarn", "4.18.1"))).toEqual({
      npm_config_cache: NODE_PACKAGE_CACHE_PATHS.npm,
      YARN_GLOBAL_FOLDER: NODE_PACKAGE_CACHE_PATHS.yarnGlobal,
    });
  });

  test("leaves manager-specific env alone when the user already set it", () => {
    expect(
      nodePackageCacheEnvironment({ pnpm_config_store_dir: "/tmp/pnpm" }, manager("pnpm", "11.0.0")),
    ).toEqual({
      npm_config_cache: NODE_PACKAGE_CACHE_PATHS.npm,
    });
    expect(
      nodePackageCacheEnvironment({ YARN_CACHE_FOLDER: "/tmp/yarn" }, manager("yarn", "1.22.22")),
    ).toEqual({
      npm_config_cache: NODE_PACKAGE_CACHE_PATHS.npm,
    });
  });
});

describe("shared Node package cache", () => {
  test("mounts the shared cache, seeds 1777, and sets npm_config_cache", async () => {
    const plan = await composeNodePlan({});

    expect(cacheMount(plan)).toEqual([
      {
        type: "volume",
        origin: "service",
        store: NODE_PACKAGE_CACHE.store,
        target: PortablePath.make(NODE_PACKAGE_CACHE_TARGET),
        readOnly: false,
      },
    ]);
    expect(plan.environment.npm_config_cache).toBe(NODE_PACKAGE_CACHE_PATHS.npm);
    expect(plan.environment.npm_config_store_dir).toBeUndefined();
    expect(plan.environment.pnpm_config_store_dir).toBeUndefined();
    expect(plan.environment.YARN_CACHE_FOLDER).toBeUndefined();
    expect(plan.environment.YARN_GLOBAL_FOLDER).toBeUndefined();
    expect(buildStepsFor(plan).find((step) => step.id === NODE_PACKAGE_CACHE_STEP_ID)).toEqual({
      id: NODE_PACKAGE_CACHE_STEP_ID,
      phase: "build",
      user: "root",
      command: ["sh", "-c", NODE_PACKAGE_CACHE_PREPARE],
    });
    expect(NODE_PACKAGE_CACHE_PREPARE).toContain("chmod 1777");
  });

  test("leaves a user-set npm_config_cache alone while still mounting the cache", async () => {
    const plan = await composeNodePlan({ environment: { npm_config_cache: "/tmp/my-npm" } });

    expect(cacheMount(plan)).toHaveLength(1);
    expect(plan.environment.npm_config_cache).toBe("/tmp/my-npm");
  });

  test("sets pnpm 10 and pnpm 11 store env from the selected manager", async () => {
    const pnpm10 = await composeNodePlan({}, [packageJson({ packageManager: "pnpm@10.15.0" })]);
    const pnpm11 = await composeNodePlan({}, [packageJson({ packageManager: "pnpm@11.0.0" })]);

    expect(pnpm10.environment.npm_config_store_dir).toBe(NODE_PACKAGE_CACHE_PATHS.pnpm);
    expect(pnpm10.environment.pnpm_config_store_dir).toBeUndefined();
    expect(pnpm11.environment.pnpm_config_store_dir).toBe(NODE_PACKAGE_CACHE_PATHS.pnpm);
    expect(pnpm11.environment.npm_config_store_dir).toBeUndefined();
  });

  test("sets Yarn classic and Berry cache env from the selected manager", async () => {
    const classic = await composeNodePlan({}, [packageJson({ packageManager: "yarn@1.22.22" })]);
    const berry = await composeNodePlan({}, [packageJson({ packageManager: "yarn@4.18.1" })]);

    expect(classic.environment.YARN_CACHE_FOLDER).toBe(NODE_PACKAGE_CACHE_PATHS.yarn);
    expect(classic.environment.YARN_GLOBAL_FOLDER).toBeUndefined();
    expect(berry.environment.YARN_GLOBAL_FOLDER).toBe(NODE_PACKAGE_CACHE_PATHS.yarnGlobal);
    expect(berry.environment.YARN_CACHE_FOLDER).toBeUndefined();
  });

  test.each([
    { label: "packageCache is false", overrides: { packageCache: false } },
    { label: "the image is custom", overrides: { image: "my/node:22" } },
    { label: "the build replaces the image", overrides: { build: { context: "." } } },
  ])("does not configure a shared cache when $label", async ({ overrides }) => {
    const plan = await composeNodePlan(overrides);

    expect(cacheMount(plan)).toEqual([]);
    expect(plan.environment.npm_config_cache).toBeUndefined();
    expect(buildStepsFor(plan).some((step) => step.id === NODE_PACKAGE_CACHE_STEP_ID)).toBe(false);
  });

  test("keeps the shared cache when the authored image is the catalog reference", async () => {
    const plan = await composeNodePlan({ image: "node:22" });

    expect(cacheMount(plan)).toHaveLength(1);
    expect(plan.environment.npm_config_cache).toBe(NODE_PACKAGE_CACHE_PATHS.npm);
  });

  test("lets an authored mount at the cache target replace the shared volume", async () => {
    const plan = await composeNodePlan({
      mounts: [`/tmp/my-node-cache:${NODE_PACKAGE_CACHE_TARGET}`],
    });

    expect(plan.mounts.filter((mount) => mount.target === NODE_PACKAGE_CACHE_TARGET)).toEqual([
      {
        type: "bind",
        origin: "authored",
        source: "/tmp/my-node-cache",
        target: PortablePath.make(NODE_PACKAGE_CACHE_TARGET),
        readOnly: false,
        realization: "passthrough",
      },
    ]);
    expect(plan.environment.npm_config_cache).toBe(NODE_PACKAGE_CACHE_PATHS.npm);
  });
});
