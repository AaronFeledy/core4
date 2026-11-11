import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireAdvisoryLockAt } from "@lando/state-store/lock";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Deferred, Effect, Fiber } from "effect";
import {
  mutateInstalledPluginRegistry,
  planInstalledPluginRegistryWrite,
  readInstalledPluginRegistry,
  recordInstalledPlugin,
  removeInstalledPlugin,
} from "../../src/plugins/installed-registry.ts";
import type { InstalledPluginRegistryMutation } from "../../src/plugins/registry-transitions.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-installed-registry-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const entry = { name: "example", version: "1.0.0", path: "/example" };

test.each([
  ["install", "absent", "Store", "installed"],
  ["install", "installed", "Store", "installed"],
  ["install", "linked", "Reject", undefined],
  ["link", "absent", "Store", "linked"],
  ["link", "installed", "Reject", undefined],
  ["link", "linked", "Store", "linked"],
  ["unlink", "absent", "Reject", undefined],
  ["unlink", "installed", "Reject", undefined],
  ["unlink", "linked", "Delete", undefined],
  ["remove", "absent", "Unchanged", undefined],
  ["remove", "installed", "Delete", undefined],
  ["remove", "linked", "Delete", undefined],
] as const)("%s from %s yields %s", (operation, state, tag, source) => {
  const mutation: InstalledPluginRegistryMutation =
    operation === "link"
      ? { operation, entry: { ...entry, linkedPath: "/source" } }
      : operation === "install"
        ? { operation, entry }
        : { operation, name: entry.name };
  const previous = state === "absent" ? undefined : { ...entry, source: state };
  const plan = planInstalledPluginRegistryWrite(mutation, previous);
  expect(plan._tag).toBe(tag);
  if (plan._tag === "Store") expect(plan.entry.source).toBe(source);
});

test("install chooses installed state and removes caller-supplied link fields", async () => {
  await recordInstalledPlugin(root, { ...entry, source: "linked", linkedPath: "/source" });
  expect(await readInstalledPluginRegistry(root)).toEqual({ example: { ...entry, source: "installed" } });
});

test("remove settles on absence without creating a registry file", async () => {
  await removeInstalledPlugin(root, "missing");
  await expect(readFile(join(root, "registry.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("parallel installs preserve both records", async () => {
  await Promise.all([
    recordInstalledPlugin(root, entry),
    recordInstalledPlugin(root, { ...entry, name: "other" }),
  ]);
  expect(Object.keys(await readInstalledPluginRegistry(root)).sort()).toEqual(["example", "other"]);
});

test.each(["direct", "alias"] as const)(
  "registry mutation waits for the shared advisory lock through a %s root",
  async (mode) => {
    const alias = `${root}-alias`;
    if (mode === "alias") await symlink(root, alias, "dir");
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const access = yield* PrivateFileAccessService;
          const held = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const waiting = yield* Deferred.make<void>();
          let entered = false;
          const holder = yield* Effect.forkChild(
            Effect.acquireUseRelease(
              acquireAdvisoryLockAt(join(root, ".lando-plugin-mutation.lock"), "test", {
                privateFileAccess: access,
                expireLiveOwner: false,
              }),
              () =>
                Deferred.succeed(held, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(
                    Effect.promise(() =>
                      writeFile(
                        join(root, "registry.json"),
                        JSON.stringify({ first: { ...entry, name: "first" } }),
                      ),
                    ),
                  ),
                ),
              (lock) => lock.release,
            ),
          );
          yield* Deferred.await(held);
          const writer = yield* Effect.forkChild(
            mutateInstalledPluginRegistry(
              {
                pluginsRoot: mode === "alias" ? alias : root,
                mutation: { operation: "install", entry },
                onWait: Deferred.succeed(waiting, undefined).pipe(Effect.asVoid),
              },
              (commit) =>
                Effect.promise(async () => {
                  entered = true;
                  await commit();
                }),
            ),
          );
          yield* Deferred.await(waiting);
          expect(entered).toBe(false);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(holder);
          yield* Fiber.join(writer);
        }).pipe(Effect.provide(PrivateFileAccessService.layer), Effect.timeout("5 seconds")),
      );
      expect(Object.keys(await readInstalledPluginRegistry(root)).sort()).toEqual(["example", "first"]);
    } finally {
      if (mode === "alias") await rm(alias);
    }
  },
);

test("a rollback refused by the table reports both the publication and rollback failures", async () => {
  // Given a linked claim whose failed unlink publication left an installed entry on disk.
  await writeFile(
    join(root, "registry.json"),
    JSON.stringify({ example: { ...entry, source: "linked", linkedPath: "/source" } }),
  );
  const failure = new Error("directory sync failed");
  // When the unlink publication rejects.
  const result = await Effect.runPromise(
    Effect.result(
      mutateInstalledPluginRegistry(
        { pluginsRoot: root, mutation: { operation: "unlink", name: entry.name } },
        (commit) => Effect.tryPromise({ try: commit, catch: (cause) => cause }),
        {
          writeFileAtomic: async (path) => {
            await writeFile(path, JSON.stringify({ example: { ...entry, source: "installed" } }));
            throw failure;
          },
        },
      ),
    ),
  );
  // Then the aggregate keeps the publication failure and names the refused rollback edge.
  expect(result._tag).toBe("Failure");
  if (result._tag !== "Failure" || !(result.failure instanceof AggregateError))
    throw new TypeError("Expected an aggregate publication failure");
  expect(result.failure.errors[0]).toBe(failure);
  expect(String(result.failure.errors[1])).toContain("cannot rollback-linked while installed");
});
