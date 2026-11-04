import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import { Effect } from "effect";

import { privateRuntimeDirName } from "../src/podman/managed-invocation.ts";
import {
  type ManagedPauseFsSeam,
  type ManagedPauseProcessSeam,
  type ManagedRuntimeDirFsSeam,
  type ManagedRuntimeDirStat,
  managedRuntimeDirForTeardown,
  prepareLaunchedManagedRuntimeDir,
  prepareManagedRuntimeDir,
  resolveManagedRuntimeDir,
  terminateManagedPause,
} from "../src/podman/managed-runtime-dir.ts";

type MemNode =
  | { readonly kind: "dir"; readonly uid: number; readonly mode: number }
  | { readonly kind: "file"; readonly uid: number; readonly mode: number; readonly content: string }
  | { readonly kind: "symlink"; readonly uid: number; readonly mode: number; readonly target: string };

const missing = Object.assign(new Error("ENOENT"), { code: "ENOENT" });

const normalize = (path: string): string => {
  if (path === "/") return "/";
  return path.replace(/\/+$/u, "") || "/";
};

const privateName = (canonical: string): string => privateRuntimeDirName(canonical);

const makeRuntimeFs = (
  initial: Readonly<Record<string, MemNode>>,
  options: {
    readonly realpathMap?: Readonly<Record<string, string>>;
    readonly realpathFail?: ReadonlySet<string>;
    readonly mkdirUid?: number;
  } = {},
): ManagedRuntimeDirFsSeam & {
  readonly nodes: Map<string, MemNode>;
  readonly chmodCalls: string[];
  readonly mkdirCalls: string[];
} => {
  const nodes = new Map<string, MemNode>(
    Object.entries(initial).map(([path, node]) => [normalize(path), node]),
  );
  const chmodCalls: string[] = [];
  const mkdirCalls: string[] = [];
  const realpathMap = options.realpathMap ?? {};
  const realpathFail = options.realpathFail ?? new Set<string>();
  const mkdirUid = options.mkdirUid ?? 0;

  const resolveSymlink = (path: string, follow: boolean): string => {
    let current = normalize(path);
    if (!follow) return current;
    for (let i = 0; i < 8; i += 1) {
      const node = nodes.get(current);
      if (node === undefined || node.kind !== "symlink") return current;
      current = normalize(node.target.startsWith("/") ? node.target : join(current, "..", node.target));
    }
    return current;
  };

  const readStat = (path: string, follow: boolean): ManagedRuntimeDirStat => {
    const resolved = resolveSymlink(path, follow);
    const node = nodes.get(resolved);
    if (node === undefined) throw missing;
    const direct = nodes.get(normalize(path));
    if (!follow && direct?.kind === "symlink") {
      return { isDirectory: false, isSymbolicLink: true, uid: direct.uid, mode: direct.mode };
    }
    return {
      isDirectory: node.kind === "dir",
      isSymbolicLink: false,
      uid: node.uid,
      mode: node.mode,
    };
  };

  return {
    nodes,
    chmodCalls,
    mkdirCalls,
    realpath: (path) =>
      Effect.try({
        try: () => {
          const key = normalize(path);
          if (realpathFail.has(key) || realpathFail.has(path)) throw missing;
          return realpathMap[key] ?? realpathMap[path] ?? resolveSymlink(path, true);
        },
        catch: (cause) => cause,
      }),
    stat: (path) => Effect.try({ try: () => readStat(path, true), catch: (c) => c }),
    lstat: (path) => Effect.try({ try: () => readStat(path, false), catch: (c) => c }),
    mkdir: (path, options) =>
      Effect.try({
        try: () => {
          const key = normalize(path);
          mkdirCalls.push(key);
          if (!nodes.has(key)) {
            nodes.set(key, { kind: "dir", uid: mkdirUid, mode: options.mode });
          }
        },
        catch: (cause) => cause,
      }),
    chmod: (path, mode) =>
      Effect.try({
        try: () => {
          const key = normalize(path);
          chmodCalls.push(key);
          const node = nodes.get(key);
          if (node === undefined) throw missing;
          if (node.kind === "symlink") throw Object.assign(new Error("ELOOP"), { code: "ELOOP" });
          nodes.set(key, { ...node, mode });
        },
        catch: (cause) => cause,
      }),
  };
};

const pauseStatus = (uid: number): string =>
  `Name:\tpause\nState:\tS (sleeping)\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\nGid:\t${uid}\t${uid}\t${uid}\t${uid}\n`;

const makePauseFs = (input: {
  readonly pausePid?: string;
  readonly statusByPid?: Readonly<Record<number, string>>;
  readonly nsSelf?: string;
  readonly nsByPid?: Readonly<Record<number, string>>;
  readonly environByPid?: Readonly<Record<number, string>>;
}): ManagedPauseFsSeam & { readonly unlinked: string[] } => {
  const unlinked: string[] = [];
  const statusByPid = input.statusByPid ?? {};
  const environByPid = input.environByPid ?? {};
  const nsByPid = input.nsByPid ?? {};
  return {
    unlinked,
    readFile: (path) => {
      if (path.endsWith("pause.pid")) {
        return input.pausePid === undefined ? Effect.fail(missing) : Effect.succeed(input.pausePid);
      }
      const statusMatch = path.match(/^\/proc\/(\d+)\/status$/u);
      if (statusMatch?.[1] !== undefined) {
        const body = statusByPid[Number(statusMatch[1])];
        return body === undefined ? Effect.fail(missing) : Effect.succeed(body);
      }
      const environMatch = path.match(/^\/proc\/(\d+)\/environ$/u);
      if (environMatch?.[1] !== undefined) {
        const body = environByPid[Number(environMatch[1])];
        return body === undefined ? Effect.fail(missing) : Effect.succeed(body);
      }
      return Effect.fail(missing);
    },
    unlink: (path) =>
      Effect.sync(() => {
        unlinked.push(path);
      }),
    readlink: (path) => {
      if (path === "/proc/self/ns/user") {
        return input.nsSelf === undefined ? Effect.fail(missing) : Effect.succeed(input.nsSelf);
      }
      const nsMatch = path.match(/^\/proc\/(\d+)\/ns\/user$/u);
      if (nsMatch?.[1] !== undefined) {
        const target = nsByPid[Number(nsMatch[1])];
        return target === undefined ? Effect.fail(missing) : Effect.succeed(target);
      }
      return Effect.fail(missing);
    },
  };
};

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

describe("resolveManagedRuntimeDir / prepareManagedRuntimeDir", () => {
  const uid = 4242;
  const runtimeDir = "/data/runtime";
  const canonical = "/canonical/runtime";
  const runUser = `/run/user/${uid}`;
  const xdg = "/xdg/runtime";
  const expectedUnderRun = join(runUser, privateName(canonical));
  const expectedUnderXdg = join(xdg, privateName(canonical));

  const baseSeams = (fs: ManagedRuntimeDirFsSeam, envXdg = xdg) => ({
    fs,
    getuid: () => uid,
    env: { XDG_RUNTIME_DIR: envXdg },
    providerId: "lando" as const,
  });

  test("prepares the resolved private directory without resolving it again", async () => {
    const privateRuntimeDir = "/session/selected-runtime";
    const fs = makeRuntimeFs({
      [privateRuntimeDir]: { kind: "dir", uid, mode: 0o755 },
    });
    const seams = baseSeams({
      ...fs,
      realpath: () => Effect.die("resolved runtime must not be resolved again"),
      stat: () => Effect.die("resolved runtime must not select another base"),
    });

    const prepared = await run(prepareManagedRuntimeDir(runtimeDir, seams, { privateRuntimeDir }));

    expect(prepared).toBe(privateRuntimeDir);
    expect(fs.nodes.get(privateRuntimeDir)).toEqual({ kind: "dir", uid, mode: 0o700 });
  });

  test("prefers /run/user/<uid>, hashes realpath, creates 0700", async () => {
    const fs = makeRuntimeFs(
      {
        [runUser]: { kind: "dir", uid, mode: 0o700 },
        [xdg]: { kind: "dir", uid, mode: 0o700 },
        [runtimeDir]: { kind: "dir", uid, mode: 0o755 },
      },
      { realpathMap: { [runtimeDir]: canonical }, mkdirUid: uid },
    );

    const resolved = await run(resolveManagedRuntimeDir(runtimeDir, baseSeams(fs)));
    expect(resolved).toBe(expectedUnderRun);

    const prepared = await run(prepareManagedRuntimeDir(runtimeDir, baseSeams(fs)));
    expect(prepared).toBe(expectedUnderRun);
    expect(fs.nodes.get(normalize(expectedUnderRun))).toEqual({ kind: "dir", uid, mode: 0o700 });
    expect(fs.chmodCalls).toContain(normalize(expectedUnderRun));
  });

  test("falls back to env XDG_RUNTIME_DIR when /run/user/<uid> is unusable", async () => {
    const fs = makeRuntimeFs(
      {
        [xdg]: { kind: "dir", uid, mode: 0o700 },
        [runtimeDir]: { kind: "dir", uid, mode: 0o755 },
      },
      { realpathMap: { [runtimeDir]: canonical }, mkdirUid: uid },
    );

    const prepared = await run(prepareManagedRuntimeDir(runtimeDir, baseSeams(fs)));
    expect(prepared).toBe(expectedUnderXdg);
  });

  test("realpath failure falls back to resolve(runtimeDir) for the hash key", async () => {
    const unresolved = "/missing/runtime-dir";
    const fallbackCanonical = resolve(unresolved);
    const fs = makeRuntimeFs(
      { [xdg]: { kind: "dir", uid, mode: 0o700 } },
      { realpathFail: new Set([unresolved, normalize(unresolved)]) },
    );
    const expected = join(xdg, privateName(fallbackCanonical));
    const resolved = await run(resolveManagedRuntimeDir(unresolved, baseSeams(fs)));
    expect(resolved).toBe(expected);
  });

  test("base stat follows symlink; group-writable or foreign-owned base rejected", async () => {
    const linkedTarget = "/real/xdg";
    const linkedXdg = "/linked/xdg";
    const fsFollow = makeRuntimeFs(
      {
        [linkedTarget]: { kind: "dir", uid, mode: 0o700 },
        [linkedXdg]: { kind: "symlink", uid, mode: 0o777, target: linkedTarget },
        [runtimeDir]: { kind: "dir", uid, mode: 0o755 },
      },
      { realpathMap: { [runtimeDir]: canonical } },
    );

    const viaSymlinkBase = await run(resolveManagedRuntimeDir(runtimeDir, baseSeams(fsFollow, linkedXdg)));
    expect(viaSymlinkBase).toBe(join(linkedXdg, privateName(canonical)));

    const fsBad = makeRuntimeFs(
      {
        [runUser]: { kind: "dir", uid: uid + 1, mode: 0o700 },
        [xdg]: { kind: "dir", uid, mode: 0o770 },
        [runtimeDir]: { kind: "dir", uid, mode: 0o755 },
      },
      { realpathMap: { [runtimeDir]: canonical } },
    );
    expect(await run(resolveManagedRuntimeDir(runtimeDir, baseSeams(fsBad)))).toBeUndefined();
    const error = await run(prepareManagedRuntimeDir(runtimeDir, baseSeams(fsBad)).pipe(Effect.flip));
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(error).toMatchObject({
      _tag: "ProviderUnavailableError",
      details: { prerequisite: "xdg-runtime-dir" },
    });
    expect(error.message).toContain("private runtime directory base");
    expect(fsBad.chmodCalls).toEqual([]);
  });

  test("does not chmod foreign-owned private dir or follow private symlink", async () => {
    const foreignPrivate = expectedUnderXdg;
    const fsForeign = makeRuntimeFs(
      {
        [xdg]: { kind: "dir", uid, mode: 0o700 },
        [foreignPrivate]: { kind: "dir", uid: uid + 9, mode: 0o700 },
        [runtimeDir]: { kind: "dir", uid, mode: 0o755 },
      },
      { realpathMap: { [runtimeDir]: canonical } },
    );
    const errForeign = await run(
      prepareManagedRuntimeDir(runtimeDir, baseSeams(fsForeign)).pipe(Effect.flip),
    );
    expect(errForeign).toBeInstanceOf(ProviderUnavailableError);
    expect(fsForeign.chmodCalls).toEqual([]);

    const evilTarget = "/evil/target";
    const fsLink = makeRuntimeFs(
      {
        [xdg]: { kind: "dir", uid, mode: 0o700 },
        [evilTarget]: { kind: "dir", uid, mode: 0o700 },
        [expectedUnderXdg]: { kind: "symlink", uid, mode: 0o777, target: evilTarget },
        [runtimeDir]: { kind: "dir", uid, mode: 0o755 },
      },
      { realpathMap: { [runtimeDir]: canonical } },
    );
    const errLink = await run(prepareManagedRuntimeDir(runtimeDir, baseSeams(fsLink)).pipe(Effect.flip));
    expect(errLink).toBeInstanceOf(ProviderUnavailableError);
    expect(fsLink.chmodCalls).toEqual([]);
    expect(fsLink.nodes.get(normalize(evilTarget))).toEqual({ kind: "dir", uid, mode: 0o700 });
  });

  test("name is deterministic from realpath of runtimeDir", async () => {
    const fs = makeRuntimeFs(
      {
        [xdg]: { kind: "dir", uid, mode: 0o700 },
        [runtimeDir]: { kind: "dir", uid, mode: 0o755 },
      },
      { realpathMap: { [runtimeDir]: canonical } },
    );
    const a = await run(resolveManagedRuntimeDir(runtimeDir, baseSeams(fs)));
    const b = await run(resolveManagedRuntimeDir(runtimeDir, baseSeams(fs)));
    expect(a).toBe(b);
    expect(a).toBe(expectedUnderXdg);
  });
});

describe("prepareLaunchedManagedRuntimeDir", () => {
  const uid = 4242;
  const runtimeDir = "/data/runtime";
  const canonical = "/canonical/runtime";
  const launchStatePath = "/data/runtime/run/podman.pid.launch.json";
  const launched = join("/old/xdg", privateName(canonical));
  const current = join(`/run/user/${uid}`, privateName(canonical));
  const seams = (fs: ManagedRuntimeDirFsSeam) => ({
    fs,
    getuid: () => uid,
    env: {},
    readFile: (path: string) =>
      path === launchStatePath
        ? Effect.succeed(JSON.stringify({ pid: 1, env: { XDG_RUNTIME_DIR: launched } }))
        : Effect.fail(missing),
  });
  const baseNodes = {
    [`/run/user/${uid}`]: { kind: "dir", uid, mode: 0o700 },
    [runtimeDir]: { kind: "dir", uid, mode: 0o755 },
  } as const;

  test("reuses the dir a still-present service launched with", async () => {
    const fs = makeRuntimeFs(
      { ...baseNodes, [launched]: { kind: "dir", uid, mode: 0o700 } },
      { realpathMap: { [runtimeDir]: canonical }, mkdirUid: uid },
    );
    expect(await run(prepareLaunchedManagedRuntimeDir(runtimeDir, seams(fs)))).toBe(launched);
  });

  test("prepares the current dir once the launched one is gone", async () => {
    const fs = makeRuntimeFs(baseNodes, { realpathMap: { [runtimeDir]: canonical }, mkdirUid: uid });
    expect(await run(prepareLaunchedManagedRuntimeDir(runtimeDir, seams(fs)))).toBe(current);
  });
});

describe("managedRuntimeDirForTeardown", () => {
  const uid = 4242;
  const runtimeDir = "/data/runtime";
  const canonical = "/canonical/runtime";
  const launchStatePath = "/data/runtime/run/podman.pid.launch.json";
  const fs = makeRuntimeFs(
    {
      [`/run/user/${uid}`]: { kind: "dir", uid, mode: 0o700 },
      [runtimeDir]: { kind: "dir", uid, mode: 0o755 },
    },
    { realpathMap: { [runtimeDir]: canonical }, mkdirUid: uid },
  );
  const seams = (launchState: string | undefined) => ({
    fs,
    getuid: () => uid,
    env: {},
    readFile: (path: string) =>
      path === launchStatePath && launchState !== undefined
        ? Effect.succeed(launchState)
        : Effect.fail(missing),
  });
  const launchedWith = (dir: string) => JSON.stringify({ pid: 1, env: { XDG_RUNTIME_DIR: dir } });

  test("uses the dir the service launched with after the session base moved", async () => {
    const launched = join("/old/xdg", privateName(canonical));
    expect(await run(managedRuntimeDirForTeardown(runtimeDir, seams(launchedWith(launched))))).toBe(launched);
  });

  test("ignores a record whose name does not belong to this runtime dir", async () => {
    const resolved = join(`/run/user/${uid}`, privateName(canonical));
    expect(await run(managedRuntimeDirForTeardown(runtimeDir, seams(launchedWith("/tmp/elsewhere"))))).toBe(
      resolved,
    );
    expect(await run(managedRuntimeDirForTeardown(runtimeDir, seams(undefined)))).toBe(resolved);
  });
});

describe("terminateManagedPause", () => {
  const privateDir = "/private/runtime";
  const pausePath = join(privateDir, "libpod", "tmp", "pause.pid");
  const nsPath = join(privateDir, "libpod", "tmp", "ns_handles");
  const ourUid = 1000;

  const processSeam = (
    alive: boolean,
    killed: Array<{ pid: number; signal: NodeJS.Signals }>,
  ): ManagedPauseProcessSeam => ({
    isAlive: () => Effect.succeed(alive),
    kill: (pid, signal) =>
      Effect.sync(() => {
        killed.push({ pid, signal });
      }),
  });

  const pauseEnviron = (xdg: string) => `HOME=/home/u\0XDG_RUNTIME_DIR=${xdg}\0_PODMAN_PAUSE=1\0`;

  test("SIGKILLs only when alive, status Uid matches, and user ns differs; cleans paths", async () => {
    const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const fs = makePauseFs({
      pausePid: "4242\n",
      statusByPid: { 4242: pauseStatus(ourUid) },
      nsSelf: "user:[1]",
      nsByPid: { 4242: "user:[2]" },
      environByPid: { 4242: pauseEnviron(privateDir) },
    });
    await run(
      terminateManagedPause(privateDir, { fs, process: processSeam(true, killed), getuid: () => ourUid }),
    );
    expect(killed).toEqual([{ pid: 4242, signal: "SIGKILL" }]);
    expect(fs.unlinked).toEqual([pausePath, nsPath]);
  });

  test("does not kill another data root's pause that reused the recorded pid", async () => {
    const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const fs = makePauseFs({
      pausePid: "4242\n",
      statusByPid: { 4242: pauseStatus(ourUid) },
      nsSelf: "user:[1]",
      nsByPid: { 4242: "user:[2]" },
      environByPid: { 4242: pauseEnviron("/run/user/1000/lando-0123456789abcdef") },
    });
    await run(
      terminateManagedPause(privateDir, { fs, process: processSeam(true, killed), getuid: () => ourUid }),
    );
    expect(killed).toEqual([]);
    expect(fs.unlinked).toEqual([]);
  });

  test("does not kill when user ns matches (pid reuse fail-safe)", async () => {
    const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const fs = makePauseFs({
      pausePid: "9",
      statusByPid: { 9: pauseStatus(1) },
      nsSelf: "user:[same]",
      nsByPid: { 9: "user:[same]" },
    });
    await run(terminateManagedPause("/p", { fs, process: processSeam(true, killed), getuid: () => 1 }));
    expect(killed).toEqual([]);
    expect(fs.unlinked).toEqual([]);
  });

  test("does not kill when /proc/<pid>/status Uid differs (ignores any proc stat)", async () => {
    const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const fs = makePauseFs({
      pausePid: "9",
      statusByPid: { 9: pauseStatus(2) },
      nsSelf: "user:[a]",
      nsByPid: { 9: "user:[b]" },
    });
    await run(terminateManagedPause("/p", { fs, process: processSeam(true, killed), getuid: () => 1 }));
    expect(killed).toEqual([]);
    expect(fs.unlinked).toEqual([]);
  });

  test("does not kill when status Uid line is missing", async () => {
    const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const fs = makePauseFs({
      pausePid: "9",
      statusByPid: { 9: "Name:\tother\nState:\tR\n" },
      nsSelf: "user:[a]",
      nsByPid: { 9: "user:[b]" },
    });
    await run(terminateManagedPause("/p", { fs, process: processSeam(true, killed), getuid: () => 1 }));
    expect(killed).toEqual([]);
  });

  test("cleans stale pid file when process is dead without killing", async () => {
    const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const fs = makePauseFs({ pausePid: "9" });
    await run(terminateManagedPause("/p", { fs, process: processSeam(false, killed), getuid: () => 1 }));
    expect(killed).toEqual([]);
    expect(fs.unlinked.some((p) => p.endsWith("pause.pid"))).toBe(true);
  });
});
