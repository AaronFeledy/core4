import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";

import { rememberLandofileAppRoot } from "@lando/landofile/app-root-provenance";
import { makeLandoPaths } from "@lando/paths";
import { FileIoError, FileNotFoundError, FilePermissionError } from "@lando/sdk/errors";
import { LandofileShape, PortablePath, ServiceName } from "@lando/sdk/schema";
import { AppPlanner, CacheService, FileSystem, PathsService } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import * as AppCacheService from "../../src/cache/service.ts";
import { canShadowHostPath } from "../../src/planner/shadow-host-checks.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";
import * as AppPlannerLayer from "../../src/services/planner.ts";

test.each([
  ["vendor", "vendor/"],
  ["vendor/", "./vendor"],
  ["vendor/", "vendor/"],
])("plans one canonical shadow for equivalent authored excludes %j", async (...excludes) => {
  // Given equivalent excludes, with default excludes explicitly included instead.
  const appRoot = await mkdtemp(join(tmpdir(), "lando-planner-shadow-"));
  try {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "shadowapp",
      runtime: 4,
      services: {
        web: {
          type: "node:22",
          home: false,
          appMount: {
            target: "/app",
            includes: ["node_modules", ".git", "tmp", ...(excludes.includes("vendor") ? [] : ["vendor"])],
            excludes,
          },
        },
      },
    });
    const planner = AppPlannerLayer.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          PluginRegistryLayer.layer,
          BunFileSystem.layer,
          Layer.succeed(PathsService, makeLandoPaths({ platform: "linux", home: appRoot, env: {} })),
        ),
      ),
    );

    // When the production planner assembles the app.
    const appPlan = await Effect.runPromise(
      Effect.flatMap(AppPlanner, (service) =>
        service.plan(rememberLandofileAppRoot(landofile, appRoot), TestRuntimeProvider.capabilities),
      ).pipe(Effect.provide(planner)),
    );

    // Then canonical identity produces exactly one store and one mount.
    const store = "shadowapp-web-app-vendor-64784057";
    expect(appPlan.stores).toEqual([{ name: store, scope: "service", kind: "data" }]);
    expect(appPlan.services[ServiceName.make("web")]?.storage).toEqual([
      { store, target: PortablePath.make("/app/vendor"), readOnly: false },
    ]);
  } finally {
    await rm(appRoot, { recursive: true, force: true });
  }
});

test.each([
  [new FileNotFoundError({ message: "missing", path: "/app/missing" }), true],
  [
    new FileIoError({ message: "parent is file", path: "/app/file/child", cause: { code: "ENOTDIR" } }),
    false,
  ],
  [new FilePermissionError({ message: "denied", path: "/app/private", cause: { code: "EACCES" } }), true],
  [new FileIoError({ message: "io", path: "/app/io", cause: { code: "EIO" } }), true],
] as const)("preserves shadow eligibility for stat failure %j", async (error, expected) => {
  // Given the real filesystem service with only stat failing at its boundary.
  const fileSystem = await Effect.runPromise(Effect.provide(FileSystem, BunFileSystem.layer));
  // When checking eligibility against that failure.
  const shadowed = await Effect.runPromise(
    canShadowHostPath(error.path, {
      ...fileSystem,
      stat: () => Effect.fail(error),
    }),
  );
  // Then only ENOTDIR prevents a shadow.
  expect(shadowed).toBe(expected);
});

test.each(["gitfile", "directory", "file", "directory-link", "file-link", "file-parent"] as const)(
  "plans only directory-compatible shadows when the host contains a %s",
  async (kind) => {
    // Given real excluded host entries, including a missing dependency directory.
    const appRoot = await mkdtemp(join(tmpdir(), "lando-shadow-host-"));
    try {
      const exclude = kind === "gitfile" || kind === "directory" ? ".git" : "authored";
      const path = join(appRoot, exclude);
      switch (kind) {
        case "directory":
          await mkdir(path);
          break;
        case "directory-link":
          await mkdir(join(appRoot, "actual"));
          await symlink(join(appRoot, "actual"), path);
          break;
        case "file-link":
          await Bun.write(join(appRoot, "actual"), "file");
          await symlink(join(appRoot, "actual"), path);
          break;
        case "gitfile":
        case "file":
        case "file-parent":
          await Bun.write(path, "gitdir: /elsewhere/.git/worktrees/x\n");
          break;
      }
      const effectiveExclude = kind === "file-parent" ? `${exclude}/child` : exclude;
      const landofile = Schema.decodeUnknownSync(LandofileShape)({
        name: "shadowapp",
        runtime: 4,
        services: {
          web: {
            type: "node:22",
            home: false,
            appMount: {
              target: "/app",
              excludes: exclude === ".git" ? [] : [effectiveExclude],
            },
          },
        },
      });
      const planner = AppPlannerLayer.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            PluginRegistryLayer.layer,
            BunFileSystem.layer,
            Layer.succeed(PathsService, makeLandoPaths({ platform: "linux", home: appRoot, env: {} })),
          ),
        ),
      );

      // When planning with accelerated bind mounts.
      const plan = await Effect.runPromise(
        Effect.flatMap(AppPlanner, (service) =>
          service.plan(rememberLandofileAppRoot(landofile, appRoot), {
            ...TestRuntimeProvider.capabilities,
            bindMountPerformance: "slow",
          }),
        ).pipe(Effect.provide(planner)),
      );

      // Then only directories (and missing paths) get volumes, without dropping ignores.
      const web = plan.services[ServiceName.make("web")];
      const shadow = web?.storage.find((mount) => String(mount.target) === `/app/${effectiveExclude}`);
      const shadowed = kind === "directory-link";
      expect(shadow !== undefined).toBe(shadowed);
      if (shadow !== undefined) expect(plan.stores.some((store) => store.name === shadow.store)).toBe(true);
      if (!shadowed)
        expect(
          plan.stores.some((store) => store.name.includes(kind === "gitfile" ? "app-git-" : "app-authored-")),
        ).toBe(false);
      if (exclude !== ".git") expect(web?.appMount?.excludes).toContain(effectiveExclude);
      expect(web?.mounts.some((mount) => mount.source === "/elsewhere/.git/worktrees/x")).toBe(false);
      expect(web?.storage.some((mount) => String(mount.target) === "/app/node_modules")).toBe(true);
      expect(plan.fileSync.some(({ session }) => session.excludes.includes(effectiveExclude))).toBe(true);
    } finally {
      await rm(appRoot, { recursive: true, force: true });
    }
  },
);

test("invalidates cached Git mounts when .git changes between directory and gitfile", async () => {
  // Given a cache-enabled planner and a normal checkout.
  const appRoot = await mkdtemp(join(tmpdir(), "lando-shadow-cache-"));
  const previousCacheRoot = process.env.LANDO_USER_CACHE_ROOT;
  process.env.LANDO_USER_CACHE_ROOT = join(appRoot, "cache");
  try {
    await mkdir(join(appRoot, ".git"));
    const landofile = rememberLandofileAppRoot(
      Schema.decodeUnknownSync(LandofileShape)({
        name: "shadowapp",
        runtime: 4,
        services: { web: { type: "node:22", home: false } },
      }),
      appRoot,
    );
    const cache = await Effect.runPromise(Effect.provide(CacheService, AppCacheService.layer));
    let writes = 0;
    const planner = AppPlannerLayer.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          PluginRegistryLayer.layer,
          BunFileSystem.layer,
          Layer.succeed(PathsService, makeLandoPaths({ platform: "linux", home: appRoot, env: {} })),
          Layer.succeed(CacheService, {
            ...cache,
            writeAtomic: (path, bytes) => {
              writes++;
              return cache.writeAtomic(path, bytes);
            },
          }),
        ),
      ),
    );
    const runPlan = () =>
      Effect.runPromise(
        Effect.flatMap(AppPlanner, (service) =>
          service.plan(landofile, TestRuntimeProvider.capabilities),
        ).pipe(Effect.provide(planner)),
      );
    const first = await runPlan();
    expect(
      first.services[ServiceName.make("web")]?.storage.some((mount) => mount.target === "/app/.git"),
    ).toBe(false);
    await runPlan();
    expect(writes).toBe(1);
    const metadata = join(appRoot, "worktree-meta");
    await Bun.write(join(metadata, "HEAD"), "ref: refs/heads/main\n");
    await rm(join(appRoot, ".git"), { recursive: true });
    await Bun.write(join(appRoot, ".git"), `gitdir: ${metadata}\n`);

    // When the same app is planned after only the host entry changes.
    const second = await runPlan();

    // Then the stale cache is replaced with a Git metadata bind, never a shadow.
    expect(writes).toBe(2);
    expect(
      second.services[ServiceName.make("web")]?.storage.some((mount) => mount.target === "/app/.git"),
    ).toBe(false);
    expect(second.stores.some((store) => store.name.includes("app-git-"))).toBe(false);
    expect(second.services[ServiceName.make("web")]?.mounts).toContainEqual({
      type: "bind",
      source: metadata,
      target: PortablePath.make(metadata),
      readOnly: false,
      createHostPath: false,
      realization: "passthrough",
    });
    await runPlan();
    expect(writes).toBe(2);
    await rm(join(appRoot, ".git"));
    await mkdir(join(appRoot, ".git"));
    const third = await runPlan();
    expect(writes).toBe(3);
    expect(third.services[ServiceName.make("web")]?.mounts.some((mount) => mount.source === metadata)).toBe(
      false,
    );
  } finally {
    if (previousCacheRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CACHE_ROOT");
    else process.env.LANDO_USER_CACHE_ROOT = previousCacheRoot;
    await rm(appRoot, { recursive: true, force: true });
  }
});
