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

type Node = {
  readonly uid: number;
  readonly children?: ReadonlyArray<string>;
  readonly symlink?: true;
  readonly nlink?: number;
};

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
            isFile: node.children === undefined && node.symlink !== true,
            isDirectory: node.children !== undefined,
            isSymbolicLink: node.symlink === true,
            uid: node.uid,
            gid: node.uid,
            ...(node.nlink === undefined ? {} : { nlink: node.nlink }),
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
    // A file is given back by itself; a directory read to the end with nothing to keep, recursively.
    expect(result.rootOwned.map(({ command }) => command)).toEqual([
      `sudo chown 1000:1000 '${data}/plugins/thing'`,
      `sudo chown -R 1000:1000 '${data}/setup'`,
    ]);
  });

  test("never offers a recursive chown over a directory holding a hard link; lists what inside needs fixing", async () => {
    const fs = fakeFileSystem({
      ...baseTree,
      [`${data}/setup`]: { uid: 0, children: ["readiness.json", "linked", "cache"] },
      [`${data}/setup/linked`]: { uid: 0, nlink: 2 },
      [`${data}/setup/cache`]: { uid: 0, children: ["entry"] },
      [`${data}/setup/cache/entry`]: { uid: 0 },
    });

    const result = await scan(fs);

    // In the order a person runs them: the directory alone, then what is inside it.
    expect(result.rootOwned.map(({ command }) => command)).toEqual([
      `sudo chown 1000:1000 '${data}/plugins/thing'`,
      `sudo chown 1000:1000 '${data}/setup'`,
      `sudo chown 1000:1000 '${data}/setup/readiness.json'`,
      `sudo rm -f '${data}/setup/linked'`,
      `sudo chown -R 1000:1000 '${data}/setup/cache'`,
    ]);
    expect(
      result.rootOwned.some(({ path, command }) => path === `${data}/setup` && command.includes("-R")),
    ).toBe(false);
  });

  test("a directory it could not read to the end gets no recursive chown", async () => {
    const fs = fakeFileSystem(baseTree, new Set([`${data}/setup`]));

    const result = await scan(fs);

    expect(result.rootOwned.find(({ path }) => path === `${data}/setup`)?.command).toBe(
      `sudo chown 1000:1000 '${data}/setup'`,
    );
    expect(result.incomplete.join(" ")).toContain(`${data}/setup`);
  });

  test("ignores a root-owned symlink: Lando never follows or changes one, and it blocks no write", async () => {
    const fs = fakeFileSystem({
      ...baseTree,
      [`${data}/plugins`]: { uid: 1000, children: ["thing", "link"] },
      [`${data}/plugins/link`]: { uid: 0, symlink: true },
    });

    const result = await scan(fs);

    expect(result.rootOwned.map((entry) => entry.path)).toEqual([`${data}/plugins/thing`, `${data}/setup`]);
  });

  test("a root-owned hard link is never given a chown: its remedy removes the link", async () => {
    const fs = fakeFileSystem({
      ...baseTree,
      [`${data}/plugins`]: { uid: 1000, children: ["thing", "linked"] },
      [`${data}/plugins/linked`]: { uid: 0, nlink: 2 },
    });

    const result = await scan(fs);

    const linked = result.rootOwned.find((entry) => entry.path === `${data}/plugins/linked`);
    // `-f`: a plain `rm` would stop to ask about a file the user cannot write.
    expect(linked).toMatchObject({ kind: "hard-link", command: `rm -f '${data}/plugins/linked'` });
    expect(linked?.remediation).toBe(
      `This file is a hard link to a file outside Lando's files, so changing its owner would change that file too. Remove the link; Lando creates it again if it needs it: \`rm -f '${data}/plugins/linked'\``,
    );
    expect(linked?.remediation).not.toContain("chown");
    expect(result.rootOwned.find((entry) => entry.path === `${data}/plugins/thing`)?.kind).toBe("owned");
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
