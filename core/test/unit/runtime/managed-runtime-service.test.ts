import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { makeLandoPaths } from "../../../src/config/paths.ts";
import {
  type FsSeam,
  type ManagedRuntimeServiceSpec,
  type ProcessSeam,
  buildManagedRuntimeServiceSpec,
  terminateOwnedRuntimeService,
  verifyOwnedRuntimePid,
} from "../../../src/runtime/managed-runtime-service.ts";

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

describe("managed runtime service spec", () => {
  test("builds the canonical managed Podman service argv from Lando paths", () => {
    const paths = makeLandoPaths({ userDataRoot: "/tmp/udr" });
    const spec = buildManagedRuntimeServiceSpec(paths);

    expect(spec.command).toEndWith("/runtime/bin/podman");
    expect(spec.command).toBe("/tmp/udr/runtime/bin/podman");
    expect(spec.args).toEqual([
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
    expect(spec.socketPath).toBe("/tmp/udr/runtime/run/podman.sock");
    expect(spec.pidPath).toBe("/tmp/udr/runtime/run/podman.pid");
  });
});

describe("verifyOwnedRuntimePid", () => {
  test("returns false when the pid file is missing", async () => {
    const processSeam = makeProcessSeam({
      readPid: () => Effect.fail(new Error("ENOENT")),
    });

    expect(await run(verifyOwnedRuntimePid(baseSpec, processSeam))).toBe(false);
  });

  test("returns false when the pid is alive but the cmdline mismatches", async () => {
    const processSeam = makeProcessSeam({
      readCmdline: () => Effect.succeed(["/usr/bin/podman", "system", "service"]),
    });

    expect(await run(verifyOwnedRuntimePid(baseSpec, processSeam))).toBe(false);
  });

  test("returns false when the pid is not alive", async () => {
    const processSeam = makeProcessSeam({
      isAlive: () => Effect.succeed(false),
    });

    expect(await run(verifyOwnedRuntimePid(baseSpec, processSeam))).toBe(false);
  });

  test("returns true when the pid is alive and argv matches exactly", async () => {
    expect(await run(verifyOwnedRuntimePid(baseSpec, makeProcessSeam()))).toBe(true);
  });
});

describe("terminateOwnedRuntimeService", () => {
  test("SIGTERMs and unlinks when the pid is owned", async () => {
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

  test("does not SIGTERM when the pid is not owned but still unlinks", async () => {
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
    expect(unlinkedPaths).toEqual([baseSpec.socketPath, baseSpec.pidPath]);
  });

  test("is idempotent when pid and socket files are already missing", async () => {
    const processSeam = makeProcessSeam({
      readPid: () => Effect.fail(new Error("ENOENT")),
    });
    const fsSeam: FsSeam = {
      unlink: () => Effect.fail(new Error("ENOENT")),
    };

    const result = await run(terminateOwnedRuntimeService(baseSpec, { process: processSeam, fs: fsSeam }));

    expect(result).toEqual({ terminated: false });
  });
});
