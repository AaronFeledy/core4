import { describe, expect, test } from "bun:test";
import { parseRepairArgs } from "@lando/engine/host/root-ownership-repair-cli";
import { makeLandoPathsFromRoots } from "@lando/paths";
import { FileNotFoundError, HostChangeFailedError } from "@lando/sdk/errors";
import type { HostChangeStepRunner, ProcessResult } from "@lando/sdk/services";
import { type FileStat, FileSystem } from "@lando/sdk/services";
import { Effect, Exit, Stream } from "effect";
import {
  REPAIR_ROOT_OWNERSHIP,
  planRootOwnershipRepair,
} from "../../src/cli/host-changes/root-ownership-change.ts";

const UID = 1000;
const home = "/home/dev";
const paths = makeLandoPathsFromRoots(
  {
    userDataRoot: `${home}/.local/share/lando`,
    userConfRoot: `${home}/.config/lando`,
    userCacheRoot: `${home}/.cache/lando`,
    systemPluginRoot: "/usr/share/lando/plugins",
  },
  "linux",
);
const { roots } = paths;
const data = roots.userDataRoot;
const cache = roots.userCacheRoot;

type Node = {
  readonly uid: number;
  readonly mode?: number;
  readonly children?: ReadonlyArray<string>;
  readonly nlink?: number;
};

/** Every ancestor of the roots exists as a directory owned by the user, `/` and `/home` by root. */
const baseTree = (): Record<string, Node> => ({
  "/": { uid: 0, mode: 0o40755, children: ["home"] },
  "/home": { uid: 0, mode: 0o40755, children: ["dev"] },
  [home]: { uid: UID, mode: 0o40750, children: [".local", ".config", ".cache"] },
  [`${home}/.local`]: { uid: UID, mode: 0o40755, children: ["share"] },
  [`${home}/.local/share`]: { uid: UID, mode: 0o40755, children: ["lando"] },
  [data]: { uid: UID, mode: 0o40755, children: ["setup", "runtime"] },
  [`${data}/setup`]: { uid: 0, mode: 0o40755, children: [] },
  [`${data}/runtime`]: { uid: UID, mode: 0o40755, children: [] },
  [`${home}/.config`]: { uid: UID, mode: 0o40755, children: ["lando"] },
  [roots.userConfRoot]: { uid: UID, mode: 0o40755, children: [] },
  [`${home}/.cache`]: { uid: UID, mode: 0o40755, children: ["lando"] },
  [cache]: { uid: 0, mode: 0o40755, children: [] },
});

const fileSystem = (tree: Record<string, Node>) =>
  FileSystem.of({
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
            ...(node.mode === undefined ? {} : { mode: node.mode }),
            ...(node.nlink === undefined ? {} : { nlink: node.nlink }),
          });
    },
    mkdir: () => Effect.die("unused"),
    remove: () => Effect.die("unused"),
    readDir: (path) => Effect.succeed(tree[path]?.children ?? []),
    readFile: () => Effect.die("unused"),
    writeFile: () => Effect.die("unused"),
  });

const plan = (tree: Record<string, Node>, platform = "linux") =>
  Effect.runPromise(
    planRootOwnershipRepair({
      paths,
      uid: UID,
      gid: UID,
      user: "dev",
      platform,
      home,
      invocation: ["/usr/local/bin/lando"],
    }).pipe(Effect.provideService(FileSystem, fileSystem(tree))),
  );

const withHardLink = (): Record<string, Node> => ({
  ...baseTree(),
  [data]: { uid: UID, mode: 0o40755, children: ["setup", "runtime", "linked"] },
  [`${data}/linked`]: { uid: 0, mode: 0o100644, nlink: 2 },
});

const runner = (result: ProcessResult): HostChangeStepRunner & { readonly ran: string[] } => {
  const ran: string[] = [];
  return {
    ran,
    run: (id) =>
      Effect.sync(() => {
        ran.push(id);
        return result;
      }),
  };
};

describe.skipIf(process.platform === "win32")("planning the root-owned files repair", () => {
  test("plans one required, standard change that runs Lando's walker on exactly the found entries", async () => {
    const { proposal, repairable, manual } = await plan(baseTree());

    expect(repairable.map(({ path }) => path)).toEqual([`${data}/setup`, cache]);
    expect(manual).toEqual([]);
    // What a person would run instead: each entry's own command, never the internal walker.
    expect(proposal?.change.manual).toBe(
      `sudo chown -R 1000:1000 '${data}/setup' && sudo chown -R 1000:1000 '${cache}'`,
    );
    expect(proposal?.change).toMatchObject({
      id: REPAIR_ROOT_OWNERSHIP,
      stage: "lando-roots",
      consent: "standard",
      requirement: "required",
      undo: { _tag: "none" },
    });
    expect(proposal?.change.steps.map(({ argv, privileged }) => ({ argv, privileged }))).toEqual([
      {
        argv: [
          "/usr/local/bin/lando",
          "__internal:repair-root-ownership",
          "--uid",
          "1000",
          "--gid",
          "1000",
          "--root",
          data,
          "--root",
          cache,
          "--storage",
          paths.runtimeStorageDir,
          "--path",
          `${data}/setup`,
          "--path",
          cache,
        ],
        privileged: true,
      },
    ]);
  });

  test("keeps a hard link manual with the command that removes it, out of the walker's paths", async () => {
    const { proposal, repairable, manual } = await plan(withHardLink());

    expect(repairable.map(({ path }) => path)).toEqual([`${data}/setup`, cache]);
    expect(manual).toEqual([
      expect.objectContaining({ path: `${data}/linked`, command: `rm -f '${data}/linked'` }),
    ]);
    expect(proposal?.change.steps[0]?.argv).not.toContain(`${data}/linked`);
    expect(proposal?.change.manual).not.toContain("linked");
  });

  test("never joins a recursive chown over a directory that holds a hard link into the manual text", async () => {
    const tree = {
      ...baseTree(),
      [`${data}/setup`]: { uid: 0, mode: 0o40755, children: ["linked", "state"] },
      [`${data}/setup/linked`]: { uid: 0, mode: 0o100644, nlink: 2 },
      [`${data}/setup/state`]: { uid: 0, mode: 0o100644 },
    };

    const { proposal, repairable, manual } = await plan(tree);

    expect(manual.map(({ command }) => command)).toEqual([`sudo rm -f '${data}/setup/linked'`]);
    expect(repairable.map(({ command }) => command)).toEqual([
      `sudo chown 1000:1000 '${data}/setup'`,
      `sudo chown 1000:1000 '${data}/setup/state'`,
      `sudo chown -R 1000:1000 '${cache}'`,
    ]);
    expect(proposal?.change.manual).not.toContain(`chown -R 1000:1000 '${data}/setup'`);
    // The walker gets the top-most path once; it never changes the link it finds inside.
    expect(proposal?.change.steps[0]?.argv.filter((word) => word.startsWith(`${data}/setup`))).toEqual([
      `${data}/setup`,
    ]);
  });

  test("passes each root once, so overlapping roots never make the walker refuse", async () => {
    const shared = makeLandoPathsFromRoots(
      {
        userDataRoot: data,
        userConfRoot: data,
        userCacheRoot: cache,
        systemPluginRoot: "/usr/share/lando/plugins",
      },
      "linux",
    );

    const { proposal } = await Effect.runPromise(
      planRootOwnershipRepair({
        paths: shared,
        uid: UID,
        gid: UID,
        user: "dev",
        platform: "linux",
        home,
        invocation: ["/usr/local/bin/lando"],
      }).pipe(Effect.provideService(FileSystem, fileSystem(baseTree()))),
    );

    const argv = proposal?.change.steps[0]?.argv ?? [];
    expect(argv.filter((word) => word === data)).toHaveLength(1);
    expect(parseRepairArgs(argv.slice(2))).not.toHaveProperty("refused");
  });

  test("leaves a missing data root, and its storage, out of the walker's request", async () => {
    // Given a root-owned cache and no data root at all.
    const tree = baseTree();
    delete tree[data];
    tree[`${home}/.local/share`] = { uid: UID, mode: 0o40755, children: [] };

    const { proposal, repairable } = await plan(tree);

    expect(repairable.map(({ path }) => path)).toEqual([cache]);
    const argv = proposal?.change.steps[0]?.argv ?? [];
    expect(argv).not.toContain(data);
    expect(argv).not.toContain("--storage");
    expect(parseRepairArgs(argv.slice(2))).toEqual({ uid: UID, gid: UID, roots: [cache], paths: [cache] });
  });

  test("leaves entries under a root the walker would refuse manual, such as a root-owned ~/.cache", async () => {
    const tree = { ...baseTree(), [`${home}/.cache`]: { uid: 0, mode: 0o40755, children: ["lando"] } };

    const { proposal, repairable, manual } = await plan(tree);

    expect(repairable.map(({ path }) => path)).toEqual([`${data}/setup`]);
    expect(manual.map(({ path }) => path)).toEqual([cache]);
    expect(proposal?.change.steps[0]?.argv).not.toContain(cache);
  });

  test.each([
    ["on macOS", baseTree(), "darwin"],
    [
      "when an ancestor of the data root is writable by others",
      { ...baseTree(), [`${home}/.local`]: { uid: UID, mode: 0o40777, children: ["share"] } },
      "linux",
    ],
  ] as const)("offers no repair %s and keeps every command manual", async (_name, tree, platform) => {
    const { proposal, manual } = await plan(tree, platform);

    expect(proposal).toBeUndefined();
    expect(manual.map(({ path }) => path)).toEqual([`${data}/setup`, cache]);
  });
});

describe.skipIf(process.platform === "win32")("applying the repair", () => {
  const apply = async (result: ProcessResult, tree = baseTree()) => {
    const { proposal } = await plan(tree);
    if (proposal === undefined) throw new Error("expected a repair");
    const steps = runner(result);
    const exit = await Effect.runPromiseExit(proposal.apply(steps));
    return { exit, ran: steps.ran };
  };

  test("a complete walk is applied with its counts", async () => {
    const { exit } = await apply({
      exitCode: 0,
      stdout: '{"changed":3,"skipped":[],"incomplete":[]}\n',
      stderr: "",
    });

    expect(exit).toEqual(Exit.succeed({ changed: true, facts: { changed: "3" } }));
  });

  test("a partial walk records what it skipped and could not finish, and both remain with their commands", async () => {
    const tree = baseTree();
    const planned = await plan(tree);
    if (planned.proposal === undefined) throw new Error("expected a repair");
    const skipped = [
      { path: `${data}/setup/x`, reason: "hard-link" },
      { path: `${data}/setup/fifo`, reason: "special-file" },
      { path: `${data}/setup/link`, reason: "symlink" },
      { path: `${data}/setup/<non-utf8>`, reason: "invalid-name" },
    ];
    const steps = runner({
      exitCode: 3,
      stdout: `${JSON.stringify({ changed: 1, skipped, incomplete: [cache] })}\n`,
      stderr: "",
    });

    const exit = await Effect.runPromiseExit(planned.proposal.apply(steps));
    tree[`${data}/setup`] = { uid: UID, mode: 0o40755, children: [] };
    const remaining = await Effect.runPromise(
      planned.remaining.pipe(Effect.provideService(FileSystem, fileSystem(tree))),
    );

    expect(Exit.isSuccess(exit) ? exit.value.facts?.incomplete : undefined).toBe(cache);
    // A symlink is never changed and blocks nothing, so it is not left over. Nothing the walker did
    // not confirm gets a chown: what it could not finish, or could not name, it says how to check.
    expect(remaining.rootOwned.map(({ path, command }) => [path, command])).toEqual([
      [`${data}/setup/x`, `rm -f '${data}/setup/x'`],
      [`${data}/setup/fifo`, `sudo chown 1000:1000 '${data}/setup/fifo'`],
      [`${data}/setup`, `ls -lb '${data}/setup'`],
      [cache, "lando setup"],
    ]);
    expect(remaining.rootOwned.find(({ path }) => path === cache)?.remediation).toContain(
      "Lando could not finish checking this directory; rerun `lando setup`.",
    );
    expect(remaining.rootOwned.some(({ command }) => command.includes("chown -R"))).toBe(false);
  });

  test.each([
    [
      "the walker refuses",
      { exitCode: 2, stdout: '{"refused":"root-parent-not-user-owned"}\n', stderr: "" },
      "root-parent-not-user-owned",
    ],
    [
      "sudo fails before the walker runs",
      { exitCode: 1, stdout: "", stderr: "sudo: a password is required" },
      "a password is required",
    ],
  ] as const)("fails with the reason when %s", async (_name, result, reason) => {
    const { exit } = await apply(result);

    const error = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined;
    const failure = error?._tag === "Fail" ? error.error : undefined;
    expect(failure).toBeInstanceOf(HostChangeFailedError);
    expect(failure instanceof HostChangeFailedError ? failure.message : "").toContain(reason);
    expect(failure instanceof HostChangeFailedError ? failure.remediation : "").toContain("sudo chown");
  });

  test("runs nothing when the entries were given back after planning", async () => {
    const tree = baseTree();
    const { proposal } = await plan(tree);
    if (proposal === undefined) throw new Error("expected a repair");
    const steps = runner({ exitCode: 0, stdout: "", stderr: "" });
    tree[`${data}/setup`] = { uid: UID, mode: 0o40755, children: [] };
    tree[cache] = { uid: UID, mode: 0o40755, children: [] };

    const exit = await Effect.runPromiseExit(proposal.apply(steps));

    expect(exit).toEqual(Exit.succeed({ changed: false }));
    expect(steps.ran).toEqual([]);
  });
});
