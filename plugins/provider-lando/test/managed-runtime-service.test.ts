import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineHttpRequest, EngineHttpResponse } from "@lando/container-runtime/engine-api";
import { makeLandoPaths } from "@lando/paths";
import { ProviderUnavailableError, StateStoreError } from "@lando/sdk/errors";
import { AbsolutePath } from "@lando/sdk/schema";
import { makePluginStateStore } from "@lando/state-store/plugin";
import { makeStateStore } from "@lando/state-store/service";

import { Deferred, Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import type { ExecConmonReaper } from "../src/exec-conmon.ts";
import {
  type FsSeam,
  type ManagedRuntimeServiceSpec,
  type ProcessSeam,
  buildManagedRuntimeServiceSpec,
  terminateOwnedRuntimeService,
  verifyOwnedRuntimePid,
} from "../src/managed-runtime-service.ts";
import { makeRuntimeShutdownStore } from "../src/runtime-shutdown.ts";
import { withRuntimeShutdownReceipt } from "../src/runtime-shutdown-teardown.ts";
import { ownerOnlyFileAccess } from "./private-file-access.ts";

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

const makeProcessSeam = (overrides: Partial<ProcessSeam> = {}): ProcessSeam => {
  let terminated = false;
  return {
    readPid: () => Effect.succeed("123\n"),
    isAlive: () => Effect.sync(() => !terminated),
    readCmdline: () => Effect.succeed([baseSpec.command, ...baseSpec.args]),
    ...overrides,
    terminate: (pid) =>
      (overrides.terminate?.(pid) ?? Effect.void).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            terminated = true;
          }),
        ),
      ),
  };
};

describe("managed runtime service spec", () => {
  test("builds the canonical managed Podman service argv from Lando paths", () => {
    const paths = makeLandoPaths({ userDataRoot: "/tmp/udr" });
    const spec = buildManagedRuntimeServiceSpec({ ...paths, platform: "linux" });

    expect(spec.command).toEndWith("/runtime/bin/podman");
    expect(spec.command).toBe("/tmp/udr/runtime/bin/podman");
    expect(spec.args).toEqual([
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
    expect(spec.socketPath).toBe("/tmp/udr/runtime/run/podman.sock");
    expect(spec.pidPath).toBe("/tmp/udr/runtime/run/podman.pid");
  });

  test("uses the Windows runtime executable name on win32", () => {
    const paths = makeLandoPaths({ userDataRoot: "/tmp/udr", platform: "win32" });
    const spec = buildManagedRuntimeServiceSpec({ ...paths, platform: "win32" });

    expect(spec.command).toBe(`${paths.runtimeBinDir}/podman.exe`);
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
  test.each([
    "running",
    "paused",
    "created",
    "list-failure",
    "exited",
    "service-alive",
    "pause-failure",
    "concurrent-admission",
  ])("private pause teardown with %s", async (state) => {
    const actions: string[] = [];
    const dir = await mkdtemp(join(tmpdir(), "lando-quiesce-"));
    try {
      const stateStore = makePluginStateStore(
        makeStateStore({ privateFileAccess: ownerOnlyFileAccess }),
        AbsolutePath.make(dir),
        ownerOnlyFileAccess,
      );
      const receipt = await Effect.runPromise(
        makeRuntimeShutdownStore(stateStore, () => Effect.succeed("boot")),
      );
      await Effect.runPromise(receipt.admit);
      const result = await run(
        withRuntimeShutdownReceipt(
          stateStore,
          terminateOwnedRuntimeService(baseSpec, {
            process: makeProcessSeam({
              ...(state === "service-alive" ? { isAlive: () => Effect.succeed(true) } : {}),
              terminate: () =>
                Effect.sync(() => {
                  actions.push("SIGTERM");
                }),
            }),
            fs: { unlink: () => Effect.void },
            terminationPolicy: { maxAttempts: 1, delay: Duration.zero, timeout: Duration.seconds(1) },
            apiClient: () => ({
              request: () =>
                Effect.gen(function* () {
                  if (state === "concurrent-admission") yield* receipt.admit;
                  return yield* state === "list-failure"
                    ? Effect.fail(
                        new ProviderUnavailableError({
                          providerId: "lando",
                          operation: "cleanup",
                          message: "list failed",
                          remediation: "test",
                        }),
                      )
                    : Effect.succeed({
                        status: 200,
                        body: JSON.stringify([
                          {
                            Id: "container",
                            State: ["service-alive", "pause-failure", "concurrent-admission"].includes(state)
                              ? "exited"
                              : state,
                          },
                        ]),
                      });
                }),
            }),
            execConmon: {
              listArgv: Effect.sync(() => {
                actions.push("conmons");
                return [];
              }),
              kill: () => Effect.void,
            },
            privateRuntimeDir: () => Effect.succeed("/private/this-root"),
            terminatePause: (path) =>
              Effect.sync(() => {
                actions.push(`pause ${path}`);
                return state !== "pause-failure";
              }),
          }),
        ),
      );
      expect(result).toEqual({
        terminated: true,
        pid: 123,
        ...(["exited", "concurrent-admission"].includes(state) ? { quiescent: true } : {}),
      });
      expect(await Effect.runPromise(receipt.read)).toMatchObject({
        state: state === "exited" ? "stopped" : "admitted",
      });
      expect(actions).toEqual(
        ["exited", "pause-failure", "concurrent-admission"].includes(state)
          ? ["SIGTERM", "conmons", "pause /private/this-root"]
          : ["SIGTERM", "conmons"],
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("stops the runtime even when the shutdown receipt lock cannot be taken", async () => {
    const actions: string[] = [];
    const lockFailure = new StateStoreError({
      reason: "lock",
      operation: "withLock",
      path: "/plugin-state",
      remediation: "test",
    });
    const result = await run(
      withRuntimeShutdownReceipt(
        {
          open: () => Effect.fail(lockFailure),
          withLock: () => Effect.fail(lockFailure),
        },
        terminateOwnedRuntimeService(baseSpec, {
          process: makeProcessSeam({
            terminate: () =>
              Effect.sync(() => {
                actions.push("SIGTERM");
              }),
          }),
          fs: { unlink: () => Effect.void },
          terminationPolicy: { maxAttempts: 1, delay: Duration.zero, timeout: Duration.seconds(1) },
          apiClient: () => ({ request: () => Effect.succeed({ status: 200, body: "[]" }) }),
          execConmon: { listArgv: Effect.succeed([]), kill: () => Effect.void },
          privateRuntimeDir: () => Effect.succeed(undefined),
        }),
      ),
    );
    expect(result).toMatchObject({ terminated: true, pid: 123 });
    expect(actions).toEqual(["SIGTERM"]);
  });
  test("removes only storage containers sequentially before SIGTERM", async () => {
    const actions: string[] = [];
    const result = await run(
      terminateOwnedRuntimeService(baseSpec, {
        process: makeProcessSeam({
          terminate: () =>
            Effect.sync(() => {
              actions.push("SIGTERM");
            }),
        }),
        fs: {
          unlink: (path) =>
            Effect.sync(() => {
              actions.push(`unlink ${path}`);
            }),
        },
        execConmon: { listArgv: Effect.succeed([]), kill: () => Effect.void },
        apiClient: (socketPath) => {
          expect(socketPath).toBe(baseSpec.socketPath);
          return {
            request: (request) =>
              Effect.sync(() => {
                actions.push(`${request.method} ${request.path}`);
                return {
                  status: 200,
                  body: JSON.stringify([
                    { Id: "build/one", State: "storage" },
                    { Id: "global", State: "running" },
                    { Id: "stopped", State: "exited" },
                    { Id: "unknown" },
                    { Id: "build-two", State: "storage" },
                  ]),
                };
              }),
          };
        },
      }),
    );
    expect(result).toEqual({ terminated: true, pid: 123 });
    expect(actions).toEqual([
      "GET /libpod/containers/json?all=true&external=true",
      "DELETE /libpod/containers/build%2Fone?force=true",
      "DELETE /libpod/containers/build-two?force=true",
      "GET /libpod/containers/json?all=true",
      "SIGTERM",
      `unlink ${baseSpec.socketPath}`,
      `unlink ${baseSpec.pidPath}`,
    ]);
  });

  test("bounds a hung reclaim before terminating the service", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const fiber = yield* Effect.forkChild(
          terminateOwnedRuntimeService(baseSpec, {
            process: makeProcessSeam(),
            fs: { unlink: () => Effect.void },
            execConmon: { listArgv: Effect.succeed([]), kill: () => Effect.void },
            apiClient: () => ({
              request: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
            }),
          }),
        );
        yield* Deferred.await(entered);
        yield* TestClock.adjust(Duration.seconds(10));
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(result).toEqual({ terminated: true, pid: 123 });
  });

  for (const processOverride of [
    { readPid: () => Effect.fail("missing") },
    { isAlive: () => Effect.succeed(false) },
    { readCmdline: () => Effect.succeed(["unowned"]) },
  ]) {
    test(`skips the API when ownership verification fails at ${Object.keys(processOverride)[0]}`, async () => {
      const requests: EngineHttpRequest[] = [];
      await run(
        terminateOwnedRuntimeService(baseSpec, {
          process: makeProcessSeam(processOverride),
          execConmon: { listArgv: Effect.succeed([]), kill: () => Effect.void },
          apiClient: () => ({
            request: (request) => {
              requests.push(request);
              return Effect.succeed({ status: 200, body: "[]" });
            },
          }),
        }),
      );
      expect(requests).toEqual([]);
    });
  }

  const apiError = new ProviderUnavailableError({
    providerId: "lando",
    operation: "cleanup",
    message: "unavailable",
    remediation: "Install or start the `lando` provider and confirm it can perform `cleanup`.",
  });
  const storageList = { status: 200, body: '[{"Id":"leftover","State":"storage"}]' };
  const reclaimFailures: ReadonlyArray<
    readonly [
      string,
      (request: EngineHttpRequest) => Effect.Effect<EngineHttpResponse, ProviderUnavailableError>,
    ]
  > = [
    ["list", () => Effect.fail(apiError)],
    ["list-status", () => Effect.succeed({ status: 500, body: "" })],
    ["json", () => Effect.succeed({ status: 200, body: "{" })],
    ["schema", () => Effect.succeed({ status: 200, body: '[{"Id":42}]' })],
    [
      "delete",
      (request) => (request.method === "DELETE" ? Effect.fail(apiError) : Effect.succeed(storageList)),
    ],
    [
      "delete-status",
      (request) => Effect.succeed(request.method === "DELETE" ? { status: 500, body: "" } : storageList),
    ],
  ];

  for (const [failure, respond] of reclaimFailures) {
    test(`still terminates and unlinks when reclaim fails at ${failure}`, async () => {
      const actions: string[] = [];
      const result = await run(
        terminateOwnedRuntimeService(baseSpec, {
          process: makeProcessSeam({
            terminate: () =>
              Effect.sync(() => {
                actions.push("SIGTERM");
              }),
          }),
          fs: {
            unlink: (path) =>
              Effect.sync(() => {
                actions.push(path);
              }),
          },
          execConmon: { listArgv: Effect.succeed([]), kill: () => Effect.void },
          apiClient: () => ({ request: respond }),
          privateRuntimeDir: () => Effect.succeed("/private/this-root"),
          terminatePause: () => Effect.succeed(true),
        }),
      );
      expect(result).toEqual({
        terminated: true,
        pid: 123,
        ...(["delete", "delete-status"].includes(failure) ? { quiescent: true } : {}),
      });
      expect(actions).toEqual(["SIGTERM", baseSpec.socketPath, baseSpec.pidPath]);
    });
  }

  test("SIGKILLs only orphaned managed exec conmons when the pid file is missing", async () => {
    const killedPids: number[] = [];
    const processSeam = makeProcessSeam({
      readPid: () => Effect.fail(new Error("ENOENT")),
    });
    const execConmon: ExecConmonReaper = {
      listArgv: Effect.succeed([
        { pid: 10, argv: ["/tmp/udr/runtime/bin/conmon", "-c", "orphaned-id", "--exec-attach"] },
        {
          pid: 11,
          argv: ["/tmp/udr/runtime/bin/conmon", "-c", "live-id", "-n", "lando-global--traefik"],
        },
        { pid: 12, argv: ["/tmp/udr/runtime/bin/conmon", "-c", "live-id", "--exec-attach"] },
      ]),
      kill: (pid) =>
        Effect.sync(() => {
          killedPids.push(pid);
        }),
    };

    const result = await run(terminateOwnedRuntimeService(baseSpec, { process: processSeam, execConmon }));

    expect(result).toEqual({ terminated: false });
    expect(killedPids).toEqual([10]);
  });

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

  test("does not SIGTERM or unlink when the pid is not owned", async () => {
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

  test("does not unlink when SIGTERM fails", async () => {
    const unlinkedPaths: string[] = [];
    const processSeam = makeProcessSeam({
      terminate: () => Effect.fail(new Error("EPERM")),
    });
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
