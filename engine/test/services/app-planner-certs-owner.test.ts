import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";

import { type AppPlan, LandofileShape, ServiceName } from "@lando/sdk/schema";
import { PathsService } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { routeOwnerFromPlan } from "../../src/lifecycle/route-owner.ts";
import { serviceCertificatesOwnerDir } from "../../src/lifecycle/service-certificate-paths.ts";
import { planApp } from "../../src/planner/assemble.ts";
import { FileSyncPolicy, makeFileSyncPolicy } from "../../src/plugins/file-sync-policy.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import { SCRATCH_EXTENSION_KEY } from "../../src/scratch-app/identity.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";
import { literalTestLandofile } from "../compiled-landofile.ts";
import { appPlannerCertsPaths, planAppPlannerCerts } from "./app-planner-certs-harness.ts";

const web = ServiceName.make("web");

const certsLandofile = (name: string) =>
  Schema.decodeUnknownSync(LandofileShape)({
    name,
    runtime: 4,
    services: { web: { type: "node:22", certs: true } },
  });

const certMounts = (plan: AppPlan) =>
  (plan.services[web]?.mounts ?? []).filter((mount) => mount.target.startsWith("/etc/lando/certs/leaf/"));

const leafOwnerDir = (plan: AppPlan): string | undefined => {
  const mount = certMounts(plan)[0];
  return mount?.type === "bind" ? dirname(mount.source) : undefined;
};

const withRoots = async (body: (roots: { appRoot: string; cacheRoot: string }) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "lando-planner-certs-owner-"));
  const appRoot = join(root, "app");
  try {
    await mkdir(appRoot, { recursive: true });
    await body({ appRoot, cacheRoot: join(root, "cache") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("plans certs: true with no certificate authority resolver in context", async () => {
  await withRoots(async ({ appRoot, cacheRoot }) => {
    const plan = await planAppPlannerCerts({ appRoot, cacheRoot, landofile: certsLandofile("no-resolver") });
    expect(plan.services[web]?.certs?.caId).toBe("mkcert");
    expect(certMounts(plan)).toHaveLength(2);
  });
});

test.each(["user", "global"] as const)(
  "keys %s leaf paths by the owner the finished plan routes and tears down",
  async (kind) => {
    await withRoots(async ({ appRoot, cacheRoot }) => {
      const plan = await planAppPlannerCerts({
        appRoot,
        cacheRoot,
        kind,
        landofile: certsLandofile(kind === "global" ? "global" : "owned-app"),
      });
      expect(leafOwnerDir(plan)).toBe(
        serviceCertificatesOwnerDir(
          appPlannerCertsPaths({ appRoot, cacheRoot }).certsDir,
          routeOwnerFromPlan(plan).ownerKey,
        ),
      );
    });
  },
);

test("keys a scratch fork's leaf paths by its scratch owner, apart from the user app sharing its root", async () => {
  await withRoots(async ({ appRoot, cacheRoot }) => {
    // Given: a user app and a cwd fork planned at the same root
    const user = await planAppPlannerCerts({ appRoot, cacheRoot, landofile: certsLandofile("shared-root") });
    const fork = await planAppPlannerCerts({
      appRoot,
      cacheRoot,
      kind: "scratch",
      landofile: certsLandofile("scratch-fork-1"),
    });
    // When: the scratch marker is attached after planning, as scratch start does
    const marked = { ...fork, extensions: { ...fork.extensions, [SCRATCH_EXTENSION_KEY]: { id: fork.id } } };
    // Then
    const certsDir = appPlannerCertsPaths({ appRoot, cacheRoot }).certsDir;
    expect(leafOwnerDir(fork)).toBe(
      serviceCertificatesOwnerDir(certsDir, routeOwnerFromPlan(marked).ownerKey),
    );
    expect(leafOwnerDir(fork)).not.toBe(leafOwnerDir(user));
  });
});

test("config lint plans the same certificate as app planning", async () => {
  await withRoots(async ({ appRoot, cacheRoot }) => {
    // Given
    const landofile = certsLandofile("lint-agrees");
    const planned = await planAppPlannerCerts({ appRoot, cacheRoot, landofile });
    const identity = planned.identity;
    if (identity === undefined) throw new Error("expected a planned identity");
    // When: the lint path plans in validate mode
    const linted = await Effect.runPromise(
      planApp({
        landofile: literalTestLandofile(landofile, appRoot),
        providerCapabilities: TestRuntimeProvider.capabilities,
        appRoot: identity.appRoot,
        kind: "user",
        identity,
        ...(identity.dataName === undefined ? {} : { dataName: identity.dataName }),
        mode: "validate",
      }).pipe(
        Effect.provideService(FileSyncPolicy, makeFileSyncPolicy({ candidates: [], platform: "linux" })),
        Effect.provide(
          Layer.mergeAll(
            PluginRegistryLayer.layer,
            BunFileSystem.layer,
            Layer.succeed(PathsService, appPlannerCertsPaths({ appRoot, cacheRoot })),
          ),
        ),
      ),
    );
    // Then
    expect(linted.services[web]?.certs).toEqual(planned.services[web]?.certs);
    expect(certMounts(linted)).toEqual(certMounts(planned));
  });
});
