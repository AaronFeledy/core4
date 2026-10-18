import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import { FileIoError, FilePermissionError } from "@lando/sdk/errors";
import { AppPlan, ServicePlan } from "@lando/sdk/schema";
import { FileSystem } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import { readCachedAppPlan, writeCachedAppPlan } from "../../src/cache/app-plan.ts";
import * as Cache from "../../src/cache/service.ts";
import { readGitDirectories, worktreeGitMounts } from "../../src/planner/git-host-checks.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";

test.each(["stat", "gitfile", "commondir"] as const)("ignores filesystem failures at %s", async (failure) => {
  // Given a Git metadata probe whose filesystem boundary fails.
  const fs = await Effect.runPromise(Effect.provide(FileSystem, BunFileSystem.layer));
  const fileSystem = {
    ...fs,
    stat:
      failure === "stat"
        ? (path: string) => Effect.fail(new FileIoError({ path, message: "unavailable" }))
        : () => Effect.succeed({ size: 20, mtimeMs: 0, isFile: true, isDirectory: false }),
    readText: (path: string) =>
      failure === "commondir" && path === "/app/.git"
        ? Effect.succeed("gitdir: /repo/.git/worktrees/app\n")
        : Effect.fail(new FilePermissionError({ path, message: "denied" })),
  };
  // When discovering worktree metadata.
  const result = await Effect.runPromise(readGitDirectories("/app/.git", "/app", fileSystem));
  // Then planning gets no metadata mounts, rather than a failure.
  expect(result).toBeNull();
});

test.each(["", "C:\\repo\\.git", "/", "../shared\nextra"])("rejects invalid commondir %j", async (common) => {
  // Given a valid gitfile followed by invalid shared-directory metadata.
  const fs = await Effect.runPromise(Effect.provide(FileSystem, BunFileSystem.layer));
  // When reading the two metadata files.
  const result = await Effect.runPromise(
    readGitDirectories("/app/.git", "/app", {
      ...fs,
      stat: () => Effect.succeed({ size: 20, mtimeMs: 0, isFile: true, isDirectory: false }),
      readText: (path) => Effect.succeed(path === "/app/.git" ? "gitdir: /repo/worktree" : common),
    }),
  );
  // Then neither metadata directory becomes a bind target.
  expect(result).toBeNull();
});

const service = Schema.decodeUnknownSync(ServicePlan)({
  name: "web",
  type: "node",
  provider: "lando",
  primary: true,
  environment: {},
  appMount: {
    source: "/app",
    target: "/app",
    readOnly: false,
    excludes: [],
    includes: [],
    realization: "passthrough",
  },
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata: { resolvedAt: "2026-05-20T00:00:00Z", source: "test", runtime: 4 },
  extensions: {},
});

const directories = {
  gitDir: "/repo.git/worktrees/app",
  commonDir: "/repo.git",
  containerGitDir: "/repo.git/worktrees/app",
  containerCommonDir: "/repo.git",
};

test.each(["identical bind", "read-only volume", "storage"] as const)(
  "never overrides an authored %s at the Git destination",
  (kind) => {
    // Given authored intent already targeting the common-directory destination.
    const authored = Schema.decodeUnknownSync(ServicePlan)({
      ...Schema.encodeSync(ServicePlan)(service),
      ...(kind === "storage"
        ? { storage: [{ store: "repo", target: "/repo.git", readOnly: false }] }
        : {
            mounts: [
              kind === "identical bind"
                ? {
                    type: "bind",
                    source: "/repo.git",
                    target: "/repo.git",
                    readOnly: false,
                    createHostPath: false,
                    realization: "passthrough",
                  }
                : { type: "volume", target: "/repo.git", readOnly: true, realization: "passthrough" },
            ],
          }),
    });
    // When the planner considers the same metadata directory.
    const additions = worktreeGitMounts(authored, directories);
    // Then the authored entry is the only one at that destination.
    expect(additions).toEqual([]);
  },
);

test("rejects a gitdir that is not a Git directory", async () => {
  // Given a gitfile pointing at a directory without HEAD, like `gitdir: /etc`.
  const root = await mkdtemp(join(tmpdir(), "lando-git-not-git-"));
  try {
    await mkdir(join(root, "plain"));
    await Bun.write(join(root, ".git"), "gitdir: plain\n");
    const fs = await Effect.runPromise(Effect.provide(FileSystem, BunFileSystem.layer));
    // When reading the metadata directories, for both a temp dir and /etc.
    const plain = await Effect.runPromise(readGitDirectories(join(root, ".git"), "/app", fs));
    await Bun.write(join(root, ".git"), "gitdir: /etc\n");
    const etc = await Effect.runPromise(readGitDirectories(join(root, ".git"), "/app", fs));
    // Then nothing is mounted.
    expect(plain).toBeNull();
    expect(etc).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not add Git metadata binds behind an effective .git overlay", () => {
  // Given a service that explicitly shadows .git.
  const target = Schema.decodeUnknownSync(ServicePlan)({
    ...Schema.encodeSync(ServicePlan)(service),
    storage: [{ store: "git-shadow", target: "/app/.git", readOnly: false }],
  });
  // When metadata mounts are derived.
  const additions = worktreeGitMounts(target, directories);
  // Then authored overlay isolation wins over automatic Git support.
  expect(additions).toEqual([]);
});

test("invalidates cached Git metadata paths when commondir changes", async () => {
  // Given a cached plan recording resolved Git directories.
  const root = await mkdtemp(join(tmpdir(), "lando-git-host-cache-"));
  try {
    const path = join(root, ".git");
    const gitDir = join(root, "metadata");
    await Bun.write(path, "gitdir: metadata\n");
    await Bun.write(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
    await Bun.write(join(root, "common-a", "HEAD"), "ref: refs/heads/main\n");
    await Bun.write(join(root, "common-b", "HEAD"), "ref: refs/heads/main\n");
    await Bun.write(join(gitDir, "commondir"), "../common-a\n");
    const fs = await Effect.runPromise(Effect.provide(FileSystem, BunFileSystem.layer));
    const resolved = await Effect.runPromise(readGitDirectories(path, "/app", fs));
    expect(resolved).toEqual({
      gitDir,
      commonDir: join(root, "common-a"),
      containerGitDir: "/app/metadata",
      containerCommonDir: "/app/common-a",
    });
    const plan = Schema.decodeUnknownSync(AppPlan)({
      id: "git-cache",
      name: "git-cache",
      slug: "git-cache",
      root,
      provider: "lando",
      services: {},
      routes: [],
      networks: [],
      stores: [],
      fileSync: [],
      extensions: {},
      metadata: { resolvedAt: "2026-05-20T00:00:00Z", source: "test", runtime: 4 },
    });
    const input = { cacheRoot: root, appName: plan.name, appRoot: root, key: "git-cache" };
    await Effect.runPromise(
      writeCachedAppPlan({
        ...input,
        plan,
        gitHostChecks: [{ path, target: "/app", directories: resolved }],
      }).pipe(Effect.provide(Cache.layer)),
    );
    expect(await Effect.runPromise(readCachedAppPlan({ ...input, fileSystem: fs }))).not.toBeNull();
    // When only the shared metadata path changes.
    await Bun.write(join(gitDir, "commondir"), "../common-b\n");
    const cached = await Effect.runPromise(readCachedAppPlan({ ...input, fileSystem: fs }));
    // Then the old bind mount decision cannot be reused.
    expect(cached).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
