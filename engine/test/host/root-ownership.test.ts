import { describe, expect, test } from "bun:test";
import { makeLandoPathsFromRoots } from "@lando/paths";
import { FileNotFoundError, FilePermissionError } from "@lando/sdk/errors";
import { type FileStat, FileSystem } from "@lando/sdk/services";
import { Effect, Stream } from "effect";

import { scanRootOwnership } from "../../src/host/root-ownership.ts";

const paths = makeLandoPathsFromRoots(
  {
    userDataRoot: "/home/dev/.local/share/lando",
    userConfRoot: "/home/dev/.config/lando",
    userCacheRoot: "/home/dev/.cache/lando",
    systemPluginRoot: "/usr/share/lando/plugins",
  },
  "linux",
);
const { roots } = paths;

type Node = { readonly uid: number; readonly children?: ReadonlyArray<string> };

/** An in-memory tree keyed by absolute path; `unreadable` directories fail to list. */
const fakeFileSystem = (
  tree: Readonly<Record<string, Node>>,
  unreadable: ReadonlySet<string> = new Set(),
) => {
  const listed: string[] = [];
  const service = FileSystem.of({
    read: () => Stream.empty,
    readText: () => Effect.die("unused"),
    write: () => Effect.die("unused"),
    append: () => Effect.die("unused"),
    writeAtomic: () => Effect.die("unused"),
    exists: (path) => Effect.succeed(path in tree),
    stat: () => Effect.die("unused"),
    lstat: (path) => {
      const node = tree[path];
      return node === undefined
        ? Effect.fail(new FileNotFoundError({ message: "missing", path }))
        : Effect.succeed<FileStat>({
            size: 0,
            mtimeMs: 0,
            isFile: node.children === undefined,
            isDirectory: node.children !== undefined,
            isSymbolicLink: false,
            uid: node.uid,
            gid: node.uid,
          });
    },
    mkdir: () => Effect.die("unused"),
    remove: () => Effect.die("unused"),
    readDir: (path) => {
      listed.push(path);
      if (unreadable.has(path)) return Effect.fail(new FilePermissionError({ message: "EACCES", path }));
      return Effect.succeed(tree[path]?.children ?? []);
    },
    readFile: () => Effect.die("unused"),
    writeFile: () => Effect.die("unused"),
  });
  return { service, listed };
};

const data = roots.userDataRoot;
const baseTree: Record<string, Node> = {
  [data]: { uid: 1000, children: ["plugins", "runtime", "setup"] },
  [`${data}/plugins`]: { uid: 1000, children: ["thing"] },
  [`${data}/plugins/thing`]: { uid: 0 },
  [`${data}/runtime`]: { uid: 1000, children: ["storage"] },
  [`${data}/runtime/storage`]: { uid: 0, children: [] },
  [`${data}/setup`]: { uid: 0, children: ["readiness.json"] },
  [`${data}/setup/readiness.json`]: { uid: 0 },
};

const scan = (fs: ReturnType<typeof fakeFileSystem>, extra: { maxEntries?: number } = {}) =>
  Effect.runPromise(
    scanRootOwnership({ paths, uid: 1000, gid: 1000, ...extra }).pipe(
      Effect.provideService(FileSystem, fs.service),
    ),
  );

describe("scanRootOwnership", () => {
  test("lists the top-most root-owned entries and never walks provider storage", async () => {
    const fs = fakeFileSystem(baseTree);

    const result = await scan(fs);

    expect(result.rootOwned.map((entry) => entry.path)).toEqual([`${data}/plugins/thing`, `${data}/setup`]);
    expect(result.incomplete).toEqual([]);
    expect(fs.listed).not.toContain(`${data}/runtime`);
    expect(result.rootOwned[0]?.remediation).toBe(`sudo chown -R 1000:1000 '${data}/plugins/thing'`);
  });

  test("never suggests a recursive chown through the runtime's storage", async () => {
    const fs = fakeFileSystem({ ...baseTree, [data]: { uid: 0, children: [] } });

    const result = await scan(fs);

    expect(result.rootOwned[0]?.path).toBe(data);
    expect(result.rootOwned[0]?.remediation).not.toContain("-R");
  });

  test("reports truncation and unreadable directories as incomplete, never as clean", async () => {
    const unreadable = fakeFileSystem(baseTree, new Set([`${data}/plugins`]));
    const limited = fakeFileSystem(baseTree);

    const unreadableResult = await scan(unreadable);
    const limitedResult = await scan(limited, { maxEntries: 2 });

    expect(unreadableResult.incomplete.join(" ")).toContain(`${data}/plugins`);
    expect(limitedResult.incomplete).toEqual(["stopped after 2 entries"]);
  });

  test("reports nothing when Lando itself runs as root", async () => {
    const fs = fakeFileSystem(baseTree);

    const result = await Effect.runPromise(
      scanRootOwnership({ paths, uid: 0, gid: 0 }).pipe(Effect.provideService(FileSystem, fs.service)),
    );

    expect(result).toEqual({ rootOwned: [], incomplete: [] });
  });
});
