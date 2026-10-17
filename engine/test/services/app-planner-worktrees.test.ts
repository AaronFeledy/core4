import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import { rememberLandofileAppRoot } from "@lando/landofile/app-root-provenance";
import { makeLandoPaths } from "@lando/paths";
import {
  LandofileShape,
  type MountPlan,
  PortablePath,
  type ProviderCapabilities,
  ServiceName,
  appMountSyncIgnores,
} from "@lando/sdk/schema";
import { AppPlanner, PathsService } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Schema } from "effect";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";
import * as AppPlannerLayer from "../../src/services/planner.ts";

const planAt = (
  root: string,
  appMount: {
    readonly excludes?: readonly string[];
    readonly includes?: readonly string[];
    readonly readOnly?: boolean;
  },
  capabilities: ProviderCapabilities = TestRuntimeProvider.capabilities,
  service: { readonly mounts?: readonly unknown[]; readonly storage?: readonly unknown[] } = {},
) => {
  const landofile = rememberLandofileAppRoot(
    Schema.decodeUnknownSync(LandofileShape)({
      name: "gitapp",
      runtime: 4,
      services: {
        web: { type: "node:22", home: false, ...service, appMount: { target: "/app", ...appMount } },
      },
    }),
    root,
  );
  return Effect.runPromise(
    Effect.flatMap(AppPlanner, (planner) => planner.plan(landofile, capabilities)).pipe(
      Effect.provide(
        AppPlannerLayer.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              PluginRegistryLayer.layer,
              BunFileSystem.layer,
              Layer.succeed(PathsService, makeLandoPaths({ platform: "linux", home: root, env: {} })),
            ),
          ),
        ),
      ),
    ),
  );
};

const head = (dir: string) => Bun.write(join(dir, "HEAD"), "ref: refs/heads/main\n");

const gitBind = (source: string, target: string, readOnly = false): MountPlan => ({
  type: "bind",
  source,
  target: PortablePath.make(target),
  readOnly,
  createHostPath: false,
  realization: "passthrough",
});

test.each(["nested", "external", "no-commondir"] as const)(
  "binds relative in-tree worktree Git metadata at /app-relative targets (%s)",
  async (kind) => {
    // Given a gitfile with relative gitdir and, when present, relative commondir.
    const root = await mkdtemp(join(tmpdir(), "lando-worktree-"));
    try {
      const commonDir = join(root, "shared.git");
      const gitDir = kind === "nested" ? join(commonDir, "worktrees", "app") : join(root, "metadata");
      await mkdir(gitDir, { recursive: true });
      await head(gitDir);
      await head(commonDir);
      await Bun.write(
        join(root, ".git"),
        `gitdir: ${kind === "nested" ? "shared.git/worktrees/app" : "metadata"}\n`,
      );
      if (kind !== "no-commondir")
        await Bun.write(join(gitDir, "commondir"), kind === "nested" ? "../..\n" : "../shared.git\n");
      // When planning a native app mount.
      const plan = await planAt(root, {});
      const web = plan.services[ServiceName.make("web")];
      // Then host sources bind at the paths git resolves from /app, with no sync or Git shadow.
      expect(web?.mounts).toEqual(
        {
          nested: [gitBind(commonDir, "/app/shared.git")],
          external: [gitBind(commonDir, "/app/shared.git"), gitBind(gitDir, "/app/metadata")],
          "no-commondir": [gitBind(gitDir, "/app/metadata")],
        }[kind],
      );
      expect(plan.fileSync).toEqual([]);
      expect(plan.stores.some((store) => store.name.includes("-app-git-"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("binds a relative submodule gitdir at the container-resolved path", async () => {
  // Given a submodule checkout whose gitfile points into the superproject's .git/modules.
  const root = await mkdtemp(join(tmpdir(), "lando-submodule-"));
  try {
    const appRoot = join(root, "super", "sub");
    const moduleDir = join(root, "super", ".git", "modules", "sub");
    await mkdir(appRoot, { recursive: true });
    await head(moduleDir);
    await Bun.write(join(appRoot, ".git"), "gitdir: ../.git/modules/sub\n");
    // When planning a native app mount at /app.
    const plan = await planAt(appRoot, {});
    // Then the host module dir is the source and git's /app-relative resolution is the target.
    expect(plan.services[ServiceName.make("web")]?.mounts).toEqual([gitBind(moduleDir, "/.git/modules/sub")]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("binds a relative worktree common dir at the container-resolved path", async () => {
  // Given `git worktree add` with relative paths: ../main/.git/worktrees/feature plus commondir ../..
  const root = await mkdtemp(join(tmpdir(), "lando-relative-worktree-"));
  try {
    const appRoot = join(root, "feature");
    const commonDir = join(root, "main", ".git");
    const gitDir = join(commonDir, "worktrees", "feature");
    await mkdir(appRoot, { recursive: true });
    await head(gitDir);
    await head(commonDir);
    await Bun.write(join(gitDir, "commondir"), "../..\n");
    await Bun.write(join(appRoot, ".git"), "gitdir: ../main/.git/worktrees/feature\n");
    // When planning a native app mount at /app.
    const plan = await planAt(appRoot, {});
    // Then only the common dir binds, at /main/.git, where git looks from /app.
    expect(plan.services[ServiceName.make("web")]?.mounts).toEqual([gitBind(commonDir, "/main/.git")]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read-only app mounts get read-only Git binds", async () => {
  // Given an absolute worktree gitfile and a read-only app mount.
  const root = await mkdtemp(join(tmpdir(), "lando-ro-worktree-"));
  try {
    const commonDir = join(root, "repo.git");
    const gitDir = join(commonDir, "worktrees", "app");
    await head(gitDir);
    await head(commonDir);
    await Bun.write(join(gitDir, "commondir"), "../..\n");
    await Bun.write(join(root, "app", ".git"), `gitdir: ${gitDir}\n`);
    // When planning.
    const plan = await planAt(join(root, "app"), { readOnly: true });
    // Then the same-path metadata bind inherits the app mount's read-only intent.
    expect(plan.services[ServiceName.make("web")]?.mounts).toEqual([gitBind(commonDir, commonDir, true)]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an authored mount at the Git destination suppresses the derived bind", async () => {
  // Given an authored read-only volume where the common dir would be mounted.
  const root = await mkdtemp(join(tmpdir(), "lando-authored-git-"));
  try {
    const commonDir = join(root, "main", ".git");
    const gitDir = join(commonDir, "worktrees", "feature");
    await mkdir(join(root, "feature"), { recursive: true });
    await head(gitDir);
    await head(commonDir);
    await Bun.write(join(gitDir, "commondir"), "../..\n");
    await Bun.write(join(root, "feature", ".git"), "gitdir: ../main/.git/worktrees/feature\n");
    // When planning.
    const plan = await planAt(join(root, "feature"), {}, TestRuntimeProvider.capabilities, {
      mounts: [{ type: "volume", target: "/main/.git", readOnly: true }],
    });
    // Then only the authored mount occupies that destination.
    const mounts = plan.services[ServiceName.make("web")]?.mounts ?? [];
    expect(mounts.filter((mount) => mount.target === "/main/.git")).toHaveLength(1);
    expect(mounts.some((mount) => mount.type === "bind" && mount.source === commonDir)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["directory", "malformed", "empty", "windows", "root", "etc", "non-git"] as const)(
  "skips Git metadata mounts for %s",
  async (kind) => {
    // Given a normal checkout or an unusable gitfile.
    const root = await mkdtemp(join(tmpdir(), "lando-git-skip-"));
    try {
      if (kind === "directory") await mkdir(join(root, ".git"));
      else
        await Bun.write(
          join(root, ".git"),
          {
            malformed: "not a gitfile",
            empty: "gitdir:\n",
            windows: "gitdir: C:\\repo\\.git\n",
            root: "gitdir: /\n",
            etc: "gitdir: /etc\n",
            "non-git": `gitdir: ${root}\n`,
          }[kind],
        );
      // When planning native binds.
      const plan = await planAt(root, {});
      // Then .git stays visible without a metadata bind or empty overlay.
      expect(plan.services[ServiceName.make("web")]?.mounts).toEqual([]);
      expect(plan.stores.some((store) => store.name.includes("-app-git-"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("includes removes both overlay and sync ignores while files never shadow", async () => {
  // Given an excluded file and an included default exclude.
  const root = await mkdtemp(join(tmpdir(), "lando-sync-policy-"));
  try {
    await Bun.write(join(root, "some-file"), "file");
    await Bun.write(join(root, ".git"), "gitdir: /shared/repo.git/worktrees/app\n");
    // When planning an accelerated mount.
    const plan = await planAt(
      root,
      {
        excludes: ["some-file"],
        includes: ["vendor"],
      },
      { ...TestRuntimeProvider.capabilities, bindMountPerformance: "slow" },
    );
    const web = plan.services[ServiceName.make("web")];
    // Then ignores retain files, but included entries and Git binds are absent.
    expect(plan.fileSync[0]?.session.excludes).toEqual(["node_modules", "tmp", "some-file", ".git"]);
    if (web === undefined) throw new Error("Expected planned web service");
    expect(plan.fileSync[0]?.session.excludes).toEqual(appMountSyncIgnores(web));
    expect(web?.storage.map((mount) => String(mount.target)).sort()).toEqual([
      "/app/node_modules",
      "/app/tmp",
    ]);
    expect(web?.mounts).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([false, true])(
  "derives ignores from finalized storage with authored overlay=%s",
  async (overlay) => {
    // Given default policy and optionally an explicitly authored storage overlay.
    const root = await mkdtemp(join(tmpdir(), "lando-storage-sync-"));
    try {
      // When planning an accelerated service with no authored excludes.
      const plan = await planAt(
        root,
        {},
        { ...TestRuntimeProvider.capabilities, bindMountPerformance: "slow" },
        overlay ? { storage: ["/app/node_modules", "/app/public/uploads"] } : {},
      );
      // Then storage-only paths join defaults before the fixed Git ignore.
      const web = plan.services[ServiceName.make("web")];
      if (web === undefined) throw new Error("Expected planned web service");
      expect(plan.fileSync[0]?.session.excludes).toEqual(
        overlay
          ? ["node_modules", "vendor", "tmp", "public/uploads", ".git"]
          : ["node_modules", "vendor", "tmp", ".git"],
      );
      expect(plan.fileSync[0]?.session.excludes).toEqual(appMountSyncIgnores(web));
      expect(web.storage.filter((mount) => mount.target === "/app/node_modules")).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("including Git cancels its fixed ignore without creating an overlay", async () => {
  // Given an included Git directory.
  const root = await mkdtemp(join(tmpdir(), "lando-sync-only-"));
  try {
    await mkdir(join(root, ".git"));
    // When planning slow binds.
    const plan = await planAt(
      root,
      { includes: [".git"] },
      { ...TestRuntimeProvider.capabilities, bindMountPerformance: "slow" },
    );
    // Then Git is synchronized without a shadow.
    expect(plan.fileSync[0]?.session.excludes).toEqual(["node_modules", "vendor", "tmp"]);
    expect(
      plan.services[ServiceName.make("web")]?.storage.some((mount) => mount.target === "/app/.git"),
    ).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
