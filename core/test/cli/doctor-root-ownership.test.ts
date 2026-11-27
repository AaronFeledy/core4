import { describe, expect, test } from "bun:test";

import { makeLandoPaths } from "@lando/paths";
import { FilePermissionError } from "@lando/sdk/errors";
import { type FileStat, FileSystem, PathsService } from "@lando/sdk/services";
import { Effect, Stream } from "effect";

import { rootOwnershipDoctor } from "../../src/cli/commands/doctor-root-ownership.ts";

const uid = process.getuid?.() ?? 1000;
const paths = makeLandoPaths({
  userDataRoot: "/home/dev/.local/share/lando",
  userConfRoot: "/home/dev/.config/lando",
  userCacheRoot: "/home/dev/.cache/lando",
});
const data = paths.roots.userDataRoot;

/** Every path is a directory owned by the user unless listed; listed paths are root-owned. */
const fileSystem = (rootOwned: ReadonlySet<string>, unreadable: ReadonlySet<string> = new Set()) =>
  FileSystem.of({
    read: () => Stream.empty,
    readText: () => Effect.die("unused"),
    write: () => Effect.die("unused"),
    append: () => Effect.die("unused"),
    writeAtomic: () => Effect.die("unused"),
    exists: () => Effect.succeed(true),
    stat: () => Effect.die("unused"),
    lstat: (path) =>
      Effect.succeed<FileStat>({
        size: 0,
        mtimeMs: 0,
        isFile: false,
        isDirectory: true,
        uid: rootOwned.has(path) ? 0 : uid,
        gid: 0,
      }),
    mkdir: () => Effect.die("unused"),
    remove: () => Effect.die("unused"),
    readDir: (path) =>
      unreadable.has(path)
        ? Effect.fail(new FilePermissionError({ message: "EACCES", path }))
        : Effect.succeed(path === data ? ["setup"] : []),
    readFile: () => Effect.die("unused"),
    writeFile: () => Effect.die("unused"),
  });

const run = (fs: ReturnType<typeof fileSystem>) =>
  Effect.runPromise(
    rootOwnershipDoctor((text) => text).pipe(
      Effect.provideService(PathsService, paths),
      Effect.provideService(FileSystem, fs),
    ),
  );

describe.skipIf(process.platform === "win32" || uid === 0)("lando-roots doctor section", () => {
  test("fails each root-owned path with its own manual fix", async () => {
    const checks = await run(fileSystem(new Set([`${data}/setup`])));

    expect(checks.map((check) => [check.status, check.subject])).toEqual([["fail", `${data}/setup`]]);
    expect(checks[0]?.solutions[0]?.command).toBe(
      `sudo chown -R ${uid}:${process.getgid?.()} '${data}/setup'`,
    );
  });

  test("an unreadable root is a warning, never a pass", async () => {
    const checks = await run(fileSystem(new Set(), new Set([data])));

    expect(checks.map((check) => check.status)).toEqual(["warn"]);
  });

  test("passes when every inspected entry belongs to the user", async () => {
    const checks = await run(fileSystem(new Set()));

    expect(checks.map((check) => check.status)).toEqual(["pass"]);
  });
});
