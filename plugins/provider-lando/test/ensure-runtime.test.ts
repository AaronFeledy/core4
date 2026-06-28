import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Cause, Effect, Exit } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { PodmanApiClient } from "../src/capabilities.ts";
import { ensureRuntime } from "../src/ensure-runtime.ts";
import { type PodmanServiceRunner, RuntimeLaunchError } from "../src/podman-service-runner.ts";
import { RootlessPrerequisiteError, type RootlessProbes } from "../src/rootless-preflight.ts";
import type { PodmanMachineRunner, PodmanMachineStatus } from "../src/setup.ts";

const unavailable = () =>
  new ProviderUnavailableError({
    providerId: "lando",
    operation: "podman-api",
    message: "unreachable",
    remediation: "test remediation",
  });

const reachableApi = (): PodmanApiClient => ({ info: Effect.succeed({}) });
const unreachableApi = (): PodmanApiClient => ({ info: Effect.fail(unavailable()) });

const expectMissingFile = async (path: string) => {
  await readFile(path, "utf8").then(
    () => {
      throw new Error(`Expected ${path} to be missing`);
    },
    () => undefined,
  );
};
const apiReachableAfterMachineAction = (calls: string[]): PodmanApiClient => ({
  info: Effect.gen(function* () {
    if (calls.includes("start")) return {};
    return yield* Effect.fail(unavailable());
  }),
});

type Call =
  | ["launch", string]
  | ["isAlive", number]
  | ["isServiceProcess", number, string]
  | ["findMatching", string]
  | ["terminate", number];

const apiReachableAfterLaunch = (calls: Call[]): PodmanApiClient => ({
  info: Effect.gen(function* () {
    if (calls.some((call) => call[0] === "launch")) return {};
    return yield* Effect.fail(unavailable());
  }),
});

const serviceRunner = (
  calls: Call[],
  alive: boolean,
  serviceProcess = alive,
  options?: { readonly findMatchingPids?: ReadonlyArray<number> },
): PodmanServiceRunner => ({
  launch: (spec) =>
    Effect.sync(() => {
      calls.push(["launch", JSON.stringify(spec.args)]);
      return 9999;
    }),
  isAlive: (pid) =>
    Effect.sync(() => {
      calls.push(["isAlive", pid]);
      return alive;
    }),
  isServiceProcess: (pid, spec) =>
    Effect.sync(() => {
      calls.push(["isServiceProcess", pid, JSON.stringify(spec.args)]);
      return serviceProcess;
    }),
  ...(options?.findMatchingPids === undefined
    ? {}
    : {
        findMatchingServicePids: (spec) =>
          Effect.sync(() => {
            calls.push(["findMatching", JSON.stringify(spec.args)]);
            return options.findMatchingPids ?? [];
          }),
      }),
  terminate: (pid) =>
    Effect.sync(() => {
      calls.push(["terminate", pid]);
    }),
});

const failingLaunchRunner = (error: RuntimeLaunchError): PodmanServiceRunner => ({
  launch: () => Effect.fail(error),
  isAlive: () => Effect.succeed(false),
  isServiceProcess: () => Effect.succeed(false),
  terminate: () => Effect.void,
});

const throwingLaunchRunner = (): PodmanServiceRunner => ({
  launch: () =>
    Effect.sync(() => {
      throw new Error("host service launch must not be called");
    }),
  isAlive: () =>
    Effect.sync(() => {
      throw new Error("host service isAlive must not be called");
    }),
  isServiceProcess: () =>
    Effect.sync(() => {
      throw new Error("host service isServiceProcess must not be called");
    }),
  terminate: () =>
    Effect.sync(() => {
      throw new Error("host service terminate must not be called");
    }),
});

const machineRunner = (status: PodmanMachineStatus, calls: string[]): PodmanMachineRunner => ({
  inspect: Effect.sync(() => {
    calls.push("inspect");
    return status;
  }),
  create: Effect.sync(() => calls.push("create")).pipe(Effect.asVoid),
  start: Effect.sync(() => calls.push("start")).pipe(Effect.asVoid),
  stop: Effect.sync(() => calls.push("stop")).pipe(Effect.asVoid),
  upgrade: Effect.sync(() => calls.push("upgrade")).pipe(Effect.asVoid),
  teardown: Effect.sync(() => calls.push("teardown")).pipe(Effect.asVoid),
});

const paths = (dir: string) => ({
  podmanBin: join(dir, "bin", "podman"),
  storageDir: join(dir, "storage"),
  runRoot: join(dir, "run"),
  configDir: join(dir, "config"),
  socketPath: join(dir, "podman.sock"),
  pidPath: join(dir, "podman.pid"),
});

const canonicalArgs = (p: ReturnType<typeof paths>) =>
  JSON.stringify([
    "--root",
    p.storageDir,
    "--runroot",
    p.runRoot,
    "--config",
    p.configDir,
    "--storage-opt",
    `overlay.mount_program=${join(p.podmanBin, "..", "fuse-overlayfs")}`,
    "system",
    "service",
    "--time=0",
    `unix://${p.socketPath}`,
  ]);

const allPrereqs = (): ReturnType<RootlessProbes["probe"]> => ({
  subidConfigured: true,
  hasUidmapTools: true,
  cgroupsV2Delegated: true,
  hasXdgRuntimeDir: true,
});

describe("ensureRuntime", () => {
  test("reachable socket without owned argv match relaunches managed service", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-ensure-runtime-"));
    try {
      const calls: Call[] = [];
      const p = paths(dir);

      await Effect.runPromise(
        ensureRuntime({
          platform: "linux",
          podmanApi: reachableApi(),
          serviceRunner: serviceRunner(calls, true, false, { findMatchingPids: [] }),
          ...p,
        }),
      );

      expect(calls).toEqual([
        ["findMatching", canonicalArgs(p)],
        ["launch", canonicalArgs(p)],
      ]);
      expect(await readFile(p.pidPath, "utf8")).toBe("9999");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reachable socket without matching pid metadata is restarted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-ensure-runtime-"));
    try {
      const calls: Call[] = [];
      const p = paths(dir);

      await Effect.runPromise(
        ensureRuntime({
          platform: "linux",
          podmanApi: reachableApi(),
          serviceRunner: serviceRunner(calls, true),
          ...p,
        }),
      );

      expect(calls).toEqual([["launch", canonicalArgs(p)]]);
      expect(await readFile(p.pidPath, "utf8")).toBe("9999");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reachable socket with matching pid metadata is reused", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-ensure-runtime-"));
    try {
      const calls: Call[] = [];
      const p = paths(dir);
      await writeFile(p.pidPath, "4321");

      await Effect.runPromise(
        ensureRuntime({
          platform: "linux",
          podmanApi: reachableApi(),
          serviceRunner: serviceRunner(calls, true),
          ...p,
        }),
      );

      expect(calls).toEqual([
        ["isAlive", 4321],
        ["isServiceProcess", 4321, canonicalArgs(p)],
      ]);
      expect(await readFile(p.pidPath, "utf8")).toBe("4321");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reachable socket with live pid file but non-service process and no argv match does not terminate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-ensure-runtime-"));
    try {
      const calls: Call[] = [];
      const p = paths(dir);
      await writeFile(p.pidPath, "4321");

      await Effect.runPromise(
        ensureRuntime({
          platform: "linux",
          podmanApi: reachableApi(),
          serviceRunner: serviceRunner(calls, true, false, { findMatchingPids: [] }),
          ...p,
        }),
      );

      expect(calls).toEqual([
        ["isAlive", 4321],
        ["isServiceProcess", 4321, canonicalArgs(p)],
        ["findMatching", canonicalArgs(p)],
        ["isAlive", 4321],
        ["isServiceProcess", 4321, canonicalArgs(p)],
        ["isAlive", 4321],
        ["isServiceProcess", 4321, canonicalArgs(p)],
        ["launch", canonicalArgs(p)],
      ]);
      expect(calls.some((c) => c[0] === "terminate")).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reachable socket with mismatched pid metadata stops live service before relaunch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-ensure-runtime-"));
    try {
      const calls: Call[] = [];
      const p = paths(dir);
      await writeFile(p.pidPath, "4321");

      await Effect.runPromise(
        ensureRuntime({
          platform: "linux",
          podmanApi: reachableApi(),
          serviceRunner: serviceRunner(calls, true, false, { findMatchingPids: [7777] }),
          ...p,
        }),
      );

      expect(calls).toEqual([
        ["isAlive", 4321],
        ["isServiceProcess", 4321, canonicalArgs(p)],
        ["findMatching", canonicalArgs(p)],
        ["isAlive", 7777],
        ["terminate", 7777],
        ["isAlive", 4321],
        ["isServiceProcess", 4321, canonicalArgs(p)],
        ["launch", canonicalArgs(p)],
      ]);
      expect(await readFile(p.pidPath, "utf8")).toBe("9999");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("absent socket (no pid file) launches with canonical argv and writes pid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-ensure-runtime-"));
    try {
      const calls: Call[] = [];
      const p = paths(dir);

      await Effect.runPromise(
        ensureRuntime({
          platform: "linux",
          podmanApi: apiReachableAfterLaunch(calls),
          serviceRunner: serviceRunner(calls, true),
          ...p,
        }),
      );

      expect(calls).toEqual([["launch", canonicalArgs(p)]]);
      expect(await readFile(p.pidPath, "utf8")).toBe("9999");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("unreachable socket with a live stale pid reaps then relaunches", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-ensure-runtime-"));
    try {
      const calls: Call[] = [];
      const p = paths(dir);
      await writeFile(p.pidPath, "4321");
      await writeFile(p.socketPath, "stale socket placeholder");

      await Effect.runPromise(
        ensureRuntime({
          platform: "linux",
          podmanApi: apiReachableAfterLaunch(calls),
          serviceRunner: serviceRunner(calls, true),
          ...p,
        }),
      );

      expect(calls).toEqual([
        ["isAlive", 4321],
        ["isServiceProcess", 4321, canonicalArgs(p)],
        ["terminate", 4321],
        ["launch", canonicalArgs(p)],
      ]);
      await expectMissingFile(p.socketPath);
      expect(await readFile(p.pidPath, "utf8")).toBe("9999");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("stale pid that is already dead is not terminated but still relaunches", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-ensure-runtime-"));
    try {
      const calls: Call[] = [];
      const p = paths(dir);
      await writeFile(p.pidPath, "4321");

      await Effect.runPromise(
        ensureRuntime({
          platform: "linux",
          podmanApi: apiReachableAfterLaunch(calls),
          serviceRunner: serviceRunner(calls, false),
          ...p,
        }),
      );

      expect(calls).toEqual([
        ["isAlive", 4321],
        ["launch", canonicalArgs(p)],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("live stale pid is not terminated when it no longer matches the runtime service", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-ensure-runtime-"));
    try {
      const calls: Call[] = [];
      const p = paths(dir);
      await writeFile(p.pidPath, "4321");

      await Effect.runPromise(
        ensureRuntime({
          platform: "linux",
          podmanApi: apiReachableAfterLaunch(calls),
          serviceRunner: serviceRunner(calls, true, false),
          ...p,
        }),
      );

      expect(calls).toEqual([
        ["isAlive", 4321],
        ["isServiceProcess", 4321, canonicalArgs(p)],
        ["launch", canonicalArgs(p)],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("launch failure classified as rootless prerequisite surfaces RootlessPrerequisiteError", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-ensure-runtime-"));
    try {
      const launchError = new RuntimeLaunchError(
        "boom",
        { stderr: "newuidmap: command not found" },
        "newuidmap: command not found",
      );
      const p = paths(dir);
      const exit = await Effect.runPromiseExit(
        ensureRuntime({
          platform: "linux",
          podmanApi: unreachableApi(),
          serviceRunner: failingLaunchRunner(launchError),
          rootlessProbes: {
            probe: () => ({
              subidConfigured: false,
              hasUidmapTools: true,
              cgroupsV2Delegated: true,
              hasXdgRuntimeDir: true,
            }),
          },
          ...p,
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(RootlessPrerequisiteError);
          const rootlessError = failure.value as RootlessPrerequisiteError;
          expect(rootlessError.prerequisite).toBe("subid");
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("launch failure with all prereqs satisfied surfaces the generic RuntimeLaunchError", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-ensure-runtime-"));
    try {
      const launchError = new RuntimeLaunchError("boom", { stderr: "podman failed" }, "podman failed");
      const p = paths(dir);
      const exit = await Effect.runPromiseExit(
        ensureRuntime({
          platform: "linux",
          podmanApi: unreachableApi(),
          serviceRunner: failingLaunchRunner(launchError),
          rootlessProbes: { probe: allPrereqs },
          ...p,
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(RuntimeLaunchError);
          expect(failure.value).not.toBeInstanceOf(RootlessPrerequisiteError);
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("launch success still fails if the socket never becomes reachable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-ensure-runtime-"));
    try {
      const calls: Call[] = [];
      const p = paths(dir);
      const exit = await Effect.runPromiseExit(
        ensureRuntime({
          platform: "linux",
          podmanApi: unreachableApi(),
          serviceRunner: serviceRunner(calls, false),
          ...p,
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(calls).toEqual([["launch", canonicalArgs(p)]]);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(ProviderUnavailableError);
          expect(failure.value.message).toContain("did not become reachable");
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("darwin resolves the machine instead of launching a host service", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-ensure-runtime-"));
    try {
      const calls: string[] = [];
      const p = paths(dir);

      await Effect.runPromise(
        ensureRuntime({
          platform: "darwin",
          podmanApi: apiReachableAfterMachineAction(calls),
          serviceRunner: throwingLaunchRunner(),
          machineRunner: machineRunner("missing", calls),
          ...p,
        }),
      );

      expect(calls).toEqual(["inspect", "create", "start"]);
      await expectMissingFile(p.pidPath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("darwin fails when the machine starts but the API socket stays unreachable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-ensure-runtime-"));
    try {
      const calls: string[] = [];
      const p = paths(dir);
      const exit = await Effect.runPromiseExit(
        ensureRuntime({
          platform: "darwin",
          podmanApi: unreachableApi(),
          serviceRunner: throwingLaunchRunner(),
          machineRunner: machineRunner("missing", calls),
          ...p,
        }),
      );

      expect(calls).toEqual(["inspect", "create", "start"]);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(ProviderUnavailableError);
          expect(failure.value.message).toContain("did not become reachable");
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("win32 with a running machine is a no-op on the machine", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-ensure-runtime-"));
    try {
      const calls: string[] = [];
      const p = paths(dir);

      await Effect.runPromise(
        ensureRuntime({
          platform: "win32",
          podmanApi: reachableApi(),
          serviceRunner: throwingLaunchRunner(),
          machineRunner: machineRunner("running", calls),
          ...p,
        }),
      );

      expect(calls).toEqual(["inspect"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
