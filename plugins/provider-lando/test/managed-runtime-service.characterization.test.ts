/**
 * Characterization test — pins CURRENT `plugins/provider-lando/src/managed-runtime-service.ts`
 * behavior byte-for-byte before Wave 1 moves this module into
 * `plugins/provider-lando`. These assertions describe OBSERVABLE behavior
 * (exact argv, spec shape, pid-ownership verification, termination
 * semantics) that must survive the move unchanged; they intentionally do not
 * assert anything about file location or internal structure.
 *
 * Zero production-source edits. No real processes or real filesystem: every
 * test drives the module purely through its exported `ProcessSeam`/`FsSeam`
 * seams.
 */
import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import {
  type FsSeam,
  type ManagedRuntimeServiceSpec,
  type ProcessSeam,
  type RuntimeServiceSeams,
  buildManagedRuntimeServiceArgs,
  buildManagedRuntimeServiceSpec,
  managedRuntimePodmanArgv0,
  terminateOwnedRuntimeService,
  verifyOwnedRuntimePid,
} from "../src/managed-runtime-service.ts";

const run = <A>(effect: Effect.Effect<A, never>): Promise<A> => Effect.runPromise(effect);

const baseSpec: ManagedRuntimeServiceSpec = {
  command: "/tmp/udr/runtime/bin/podman",
  args: [
    "--root",
    "/tmp/udr/runtime/storage",
    "--runroot",
    "/tmp/udr/runtime/run",
    "--config",
    "/tmp/udr/runtime/config",
    "--storage-opt",
    "overlay.mount_program=/tmp/udr/runtime/bin/fuse-overlayfs",
    "system",
    "service",
    "--time=0",
    "unix:///tmp/udr/runtime/run/podman.sock",
  ],
  socketPath: "/tmp/udr/runtime/run/podman.sock",
  pidPath: "/tmp/udr/runtime/run/podman.pid",
};

const makeProcessSeam = (overrides: Partial<ProcessSeam> = {}): ProcessSeam => ({
  readPid: () => Effect.succeed("123\n"),
  isAlive: () => Effect.succeed(true),
  readCmdline: () => Effect.succeed([baseSpec.command, ...baseSpec.args]),
  terminate: () => Effect.void,
  ...overrides,
});

describe("buildManagedRuntimeServiceArgs (contract: exact managed Podman service argv)", () => {
  test("emits --root/--runroot/--config, the fuse-overlayfs storage-opt, and a unix:// socket URL with --time=0", () => {
    const args = buildManagedRuntimeServiceArgs({
      runtimeStorageDir: "/tmp/udr/runtime/storage",
      runtimeRunDir: "/tmp/udr/runtime/run",
      runtimeConfigDir: "/tmp/udr/runtime/config",
      runtimeBinDir: "/tmp/udr/runtime/bin",
      providerSocketPath: "/tmp/udr/runtime/run/podman.sock",
    });

    expect(args).toEqual([
      "--root",
      "/tmp/udr/runtime/storage",
      "--runroot",
      "/tmp/udr/runtime/run",
      "--config",
      "/tmp/udr/runtime/config",
      "--storage-opt",
      "overlay.mount_program=/tmp/udr/runtime/bin/fuse-overlayfs",
      "system",
      "service",
      "--time=0",
      "unix:///tmp/udr/runtime/run/podman.sock",
    ]);
  });

  test("omits the --storage-opt fuse-overlayfs flag entirely when runtimeBinDir is not supplied", () => {
    const args = buildManagedRuntimeServiceArgs({
      runtimeStorageDir: "/tmp/udr/runtime/storage",
      runtimeRunDir: "/tmp/udr/runtime/run",
      runtimeConfigDir: "/tmp/udr/runtime/config",
      providerSocketPath: "/tmp/udr/runtime/run/podman.sock",
    });

    expect(args).toEqual([
      "--root",
      "/tmp/udr/runtime/storage",
      "--runroot",
      "/tmp/udr/runtime/run",
      "--config",
      "/tmp/udr/runtime/config",
      "system",
      "service",
      "--time=0",
      "unix:///tmp/udr/runtime/run/podman.sock",
    ]);
  });
});

describe("managedRuntimePodmanArgv0 (contract: exact argv[0] the provider spawns and matches against /proc/<pid>/cmdline)", () => {
  test("uses the bare `podman` executable name (forward slash join) on posix platforms", () => {
    expect(managedRuntimePodmanArgv0("/tmp/udr/runtime/bin", "linux")).toBe("/tmp/udr/runtime/bin/podman");
    expect(managedRuntimePodmanArgv0("/tmp/udr/runtime/bin", "darwin")).toBe("/tmp/udr/runtime/bin/podman");
  });

  test("appends `.exe` on win32", () => {
    expect(managedRuntimePodmanArgv0("C:/udr/runtime/bin", "win32")).toBe("C:/udr/runtime/bin/podman.exe");
  });
});

describe("buildManagedRuntimeServiceSpec (contract: {command,args,socketPath,pidPath} shape)", () => {
  test("assembles the spec from ManagedRuntimeServicePaths using managedRuntimePodmanArgv0 + buildManagedRuntimeServiceArgs", () => {
    const spec = buildManagedRuntimeServiceSpec({
      platform: "linux",
      runtimeBinDir: "/tmp/udr/runtime/bin",
      runtimeRunDir: "/tmp/udr/runtime/run",
      runtimeStorageDir: "/tmp/udr/runtime/storage",
      runtimeConfigDir: "/tmp/udr/runtime/config",
      providerSocketPath: "/tmp/udr/runtime/run/podman.sock",
      providerPidPath: "/tmp/udr/runtime/run/podman.pid",
    });

    expect(spec).toEqual(baseSpec);
  });

  test("uses the Windows runtime executable name on win32", () => {
    const spec = buildManagedRuntimeServiceSpec({
      platform: "win32",
      runtimeBinDir: "C:/udr/runtime/bin",
      runtimeRunDir: "C:/udr/runtime/run",
      runtimeStorageDir: "C:/udr/runtime/storage",
      runtimeConfigDir: "C:/udr/runtime/config",
      providerSocketPath: "C:/udr/runtime/run/podman.sock",
      providerPidPath: "C:/udr/runtime/run/podman.pid",
    });

    expect(spec.command).toBe("C:/udr/runtime/bin/podman.exe");
  });
});

describe("verifyOwnedRuntimePid (contract: true only for a live pid whose cmdline exactly matches [command, ...args])", () => {
  test("returns false when the pid file cannot be read (missing)", async () => {
    const processSeam = makeProcessSeam({ readPid: () => Effect.fail(new Error("ENOENT")) });
    expect(await run(verifyOwnedRuntimePid(baseSpec, processSeam))).toBe(false);
  });

  test("returns false when the pid file content is not a bare positive integer", async () => {
    const processSeam = makeProcessSeam({ readPid: () => Effect.succeed("not-a-pid\n") });
    expect(await run(verifyOwnedRuntimePid(baseSpec, processSeam))).toBe(false);
  });

  test("returns false when the pid is not alive", async () => {
    const processSeam = makeProcessSeam({ isAlive: () => Effect.succeed(false) });
    expect(await run(verifyOwnedRuntimePid(baseSpec, processSeam))).toBe(false);
  });

  test("returns false when the pid is alive but its cmdline mismatches", async () => {
    const processSeam = makeProcessSeam({
      readCmdline: () => Effect.succeed(["/usr/bin/podman", "system", "service"]),
    });
    expect(await run(verifyOwnedRuntimePid(baseSpec, processSeam))).toBe(false);
  });

  test("returns true only when the pid is alive AND its cmdline exactly matches [command, ...args]", async () => {
    expect(await run(verifyOwnedRuntimePid(baseSpec, makeProcessSeam()))).toBe(true);
  });

  test("defaults to the real process seam when none is injected (constructible without throwing)", () => {
    expect(() => verifyOwnedRuntimePid(baseSpec)).not.toThrow();
  });
});

describe("terminateOwnedRuntimeService (contract: SIGTERM + best-effort unlink only for an owned, live pid)", () => {
  test("SIGTERMs the owned pid and unlinks socket+pid files, in that order, on success", async () => {
    const terminatedPids: number[] = [];
    const unlinkedPaths: string[] = [];
    const processSeam = makeProcessSeam({
      terminate: (pid) =>
        Effect.sync(() => {
          terminatedPids.push(pid);
        }),
    });
    const fsSeam: FsSeam = {
      unlink: (path) =>
        Effect.sync(() => {
          unlinkedPaths.push(path);
        }),
    };

    const result = await run(terminateOwnedRuntimeService(baseSpec, { process: processSeam, fs: fsSeam }));

    expect(result).toEqual({ terminated: true, pid: 123 });
    expect(terminatedPids).toEqual([123]);
    expect(unlinkedPaths).toEqual([baseSpec.socketPath, baseSpec.pidPath]);
  });

  test("does not SIGTERM or unlink when the recorded pid is not owned (cmdline mismatch)", async () => {
    const terminatedPids: number[] = [];
    const unlinkedPaths: string[] = [];
    const processSeam = makeProcessSeam({
      readCmdline: () => Effect.succeed(["/usr/bin/podman", "system", "service"]),
      terminate: (pid) =>
        Effect.sync(() => {
          terminatedPids.push(pid);
        }),
    });
    const fsSeam: FsSeam = {
      unlink: (path) =>
        Effect.sync(() => {
          unlinkedPaths.push(path);
        }),
    };

    const result = await run(terminateOwnedRuntimeService(baseSpec, { process: processSeam, fs: fsSeam }));

    expect(result).toEqual({ terminated: false });
    expect(terminatedPids).toEqual([]);
    expect(unlinkedPaths).toEqual([]);
  });

  test("SURPRISE (pinned as-is): a failed SIGTERM still reports the owned pid but skips unlinking", async () => {
    // Current code treats `terminate` failure as `{ terminated: false, pid }` (pid preserved),
    // and only unlinks when `result.terminated` is true. This is pinned exactly as-is, not
    // "fixed" — a later wave may reasonably revisit whether pid should surface here.
    const unlinkedPaths: string[] = [];
    const processSeam = makeProcessSeam({ terminate: () => Effect.fail(new Error("EPERM")) });
    const fsSeam: FsSeam = {
      unlink: (path) =>
        Effect.sync(() => {
          unlinkedPaths.push(path);
        }),
    };

    const result = await run(terminateOwnedRuntimeService(baseSpec, { process: processSeam, fs: fsSeam }));

    expect(result).toEqual({ terminated: false, pid: 123 });
    expect(unlinkedPaths).toEqual([]);
  });

  test("is idempotent / already-dead-safe: missing pid file AND already-missing socket/pid files still report {terminated:false} without throwing", async () => {
    const processSeam = makeProcessSeam({ readPid: () => Effect.fail(new Error("ENOENT")) });
    const fsSeam: FsSeam = { unlink: () => Effect.fail(new Error("ENOENT")) };

    const result = await run(terminateOwnedRuntimeService(baseSpec, { process: processSeam, fs: fsSeam }));

    expect(result).toEqual({ terminated: false });
  });

  test("defaults both seams to the real implementations when no RuntimeServiceSeams is injected (constructible without throwing)", () => {
    const seams: RuntimeServiceSeams = {};
    expect(() => terminateOwnedRuntimeService(baseSpec, seams)).not.toThrow();
  });
});
