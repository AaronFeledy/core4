import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { Cause, Duration, Effect, Exit } from "effect";

import type { PodmanApiClient } from "@lando/container-runtime/engine-api";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { RetryPolicy } from "@lando/sdk/probe";
import { ensureRuntime } from "../src/ensure-runtime.ts";
import {
  type PodmanServiceRunner,
  RuntimeLaunchError,
  buildPodmanServiceArgs,
  podmanServiceLogPath,
} from "../src/podman-service-runner.ts";
import { RootlessPrerequisiteError, type RootlessProbes } from "../src/rootless-preflight.ts";
import {
  writeLaunchState as persistLaunchState,
  recordedLaunchMatchesSpec,
} from "../src/runtime-launch-state.ts";
import {
  IntelMacUnsupportedError,
  type PodmanMachineRunner,
  type PodmanMachineStatus,
} from "../src/setup.ts";

const unavailable = () =>
  new ProviderUnavailableError({
    providerId: "lando",
    operation: "podman-api",
    message: "unreachable",
    remediation: "test remediation",
  });

const reachableApi = (): PodmanApiClient => ({
  info: Effect.succeed({}),
  ping: Effect.succeed(undefined),
  request: () => Effect.succeed({ status: 200, body: "[]" }),
});
const unreachableApi = (): PodmanApiClient => ({
  info: Effect.fail(unavailable()),
  ping: Effect.fail(unavailable()),
});

const fastReadinessPolicy: RetryPolicy = {
  maxAttempts: 3,
  delay: Duration.millis(1),
  timeout: Duration.millis(50),
};

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
  ping: Effect.gen(function* () {
    if (calls.includes("start")) return;
    return yield* Effect.fail(unavailable());
  }),
});

const apiReachableAfterAttempts = (failUntil: number): { api: PodmanApiClient; attempts: () => number } => {
  let attempts = 0;
  return {
    api: {
      info: Effect.suspend(() => {
        attempts += 1;
        return attempts > failUntil ? Effect.succeed({}) : Effect.fail(unavailable());
      }),
      ping: Effect.suspend(() => {
        attempts += 1;
        return attempts > failUntil ? Effect.succeed(undefined) : Effect.fail(unavailable());
      }),
    },
    attempts: () => attempts,
  };
};

type Call =
  | ["launch", string]
  | ["isAlive", number]
  | ["isServiceProcess", number, string]
  | ["findMatching", string]
  | ["findManaged", string]
  | ["terminate", number];

const apiReachableAfterLaunch = (calls: Call[]): PodmanApiClient => ({
  info: Effect.gen(function* () {
    if (calls.some((call) => call[0] === "launch")) return {};
    return yield* Effect.fail(unavailable());
  }),
  ping: Effect.gen(function* () {
    if (calls.some((call) => call[0] === "launch")) return;
    return yield* Effect.fail(unavailable());
  }),
});

const serviceRunner = (
  calls: Call[],
  alive: boolean,
  serviceProcess = alive,
  options?: {
    readonly findMatchingPids?: ReadonlyArray<number>;
    readonly findManagedPids?: ReadonlyArray<number>;
  },
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
  ...(options?.findManagedPids === undefined
    ? {}
    : {
        findManagedServicePids: (spec) =>
          Effect.sync(() => {
            calls.push(["findManaged", JSON.stringify(spec.args)]);
            return options.findManagedPids ?? [];
          }),
      }),
  terminate: (pid) =>
    Effect.sync(() => {
      calls.push(["terminate", pid]);
    }),
});

const serviceRunnerWritingLog = (calls: Call[], output: string): PodmanServiceRunner => ({
  launch: (spec) =>
    Effect.promise(async () => {
      calls.push(["launch", JSON.stringify(spec.args)]);
      await writeFile(podmanServiceLogPath(spec.socketPath), output);
      return 9999;
    }),
  isAlive: () => Effect.succeed(false),
  isServiceProcess: () => Effect.succeed(false),
  terminate: () => Effect.void,
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

/** Deterministic private runtime dir so ensure + builder share one value (no real FS). */
const PRIVATE_RUNTIME_DIR = "/private/test-runtime";

/** Longest user data root that still fits the managed socket under the 107-byte Unix path cap. */
const MANAGED_SOCKET_PATH_MAX_BYTES = 107;
const MANAGED_SOCKET_PATH_SUFFIX = "/runtime/run/podman.sock";
// 107 - byteLength("/runtime/run/podman.sock") === 83 (not 84: the leading slash is part of the join suffix).
const maxDataRootBytes = MANAGED_SOCKET_PATH_MAX_BYTES - Buffer.byteLength(MANAGED_SOCKET_PATH_SUFFIX);

const paths = (dir: string) => ({
  podmanBin: join(dir, "bin", "podman"),
  storageDir: join(dir, "storage"),
  runRoot: join(dir, "run"),
  configDir: join(dir, "config"),
  socketPath: join(dir, "podman.sock"),
  pidPath: join(dir, "podman.pid"),
  privateRuntimeDir: PRIVATE_RUNTIME_DIR,
});

const canonicalEnv = (p: ReturnType<typeof paths>) => buildPodmanServiceArgs(p).env;

const terminatedPidSet = (calls: ReadonlyArray<Call>): number[] =>
  [...new Set(calls.flatMap((call) => (call[0] === "terminate" ? [call[1]] : [])))].sort((a, b) => a - b);

const launchCount = (calls: ReadonlyArray<Call>): number =>
  calls.filter((call) => call[0] === "launch").length;

const expectRefusedMutation = (calls: ReadonlyArray<Call>) => {
  expect(terminatedPidSet(calls)).toEqual([]);
  expect(launchCount(calls)).toBe(0);
};

const expectPersistedPid = async (p: ReturnType<typeof paths>, pid: number) => {
  expect(await readFile(p.pidPath, "utf8")).toBe(String(pid));
};

const expectPersistedLaunchState = async (
  p: ReturnType<typeof paths>,
  pid: number,
  runtimeBundleVersion?: string,
) => {
  await expectPersistedPid(p, pid);
  expect(JSON.parse(await readFile(`${p.pidPath}.launch.json`, "utf8"))).toEqual({
    pid,
    env: canonicalEnv(p),
    ...(runtimeBundleVersion === undefined ? {} : { runtimeBundleVersion }),
  });
};

const writeLaunchState = (p: ReturnType<typeof paths>, pid: number, runtimeBundleVersion?: string) =>
  writeFile(
    `${p.pidPath}.launch.json`,
    JSON.stringify({
      pid,
      env: canonicalEnv(p),
      ...(runtimeBundleVersion === undefined ? {} : { runtimeBundleVersion }),
    }),
  );

const allPrereqs = (): ReturnType<RootlessProbes["probe"]> => ({
  subidConfigured: true,
  subidRangeSufficient: true,
  subidRangesDisjoint: true,
  hasUidmapTools: true,
  cgroupsV2Delegated: true,
  hasXdgRuntimeDir: true,
});

describe("ensureRuntime", () => {
  test.each([
    {
      label: "running",
      inventory: [{ State: "running" }],
      expect: { kind: "refuse-known" as const, runningContainers: 1 },
    },
    {
      label: "paused",
      inventory: [{ State: "paused" }],
      expect: { kind: "refuse-known" as const, runningContainers: 1 },
    },
    {
      label: "mixed-running-paused-exited",
      inventory: [{ State: "running" }, { State: "paused" }, { State: "exited" }],
      expect: { kind: "refuse-known" as const, runningContainers: 2 },
    },
    {
      label: "list-failure",
      inventory: "fail" as const,
      expect: { kind: "refuse-unknown" as const },
    },
    {
      label: "exited",
      inventory: [{ State: "exited" }],
      expect: { kind: "relaunch" as const },
    },
  ])("private XDG transition with $label containers", async ({ inventory, expect: outcome }) => {
    const dir = await mkdtemp(join(tmpdir(), "lando-xdg-transition-"));
    try {
      const p = paths(dir);
      const calls: Call[] = [];
      await writeFile(p.pidPath, "4321");
      await writeFile(
        `${p.pidPath}.launch.json`,
        JSON.stringify({ pid: 4321, env: { ...canonicalEnv(p), XDG_RUNTIME_DIR: "/old/runtime" } }),
      );
      const result = await Effect.runPromise(
        ensureRuntime({
          ...p,
          platform: "linux",
          serviceRunner: serviceRunner(calls, true),
          podmanApi: {
            ...reachableApi(),
            request: () =>
              inventory === "fail"
                ? Effect.fail(unavailable())
                : Effect.succeed({ status: 200, body: JSON.stringify(inventory) }),
          },
        }).pipe(Effect.result),
      );
      if (outcome.kind === "relaunch") {
        expect(result._tag).toBe("Success");
        expect(terminatedPidSet(calls)).toEqual([4321]);
        expect(launchCount(calls)).toBe(1);
        await expectPersistedLaunchState(p, 9999);
        return;
      }
      expect(result._tag).toBe("Failure");
      expectRefusedMutation(calls);
      if (result._tag !== "Failure") return;
      expect(result.failure.remediation).toBe("Run `lando poweroff`, then rerun the command.");
      expect(result.failure.message).toContain("keeps");
      if (outcome.kind === "refuse-known") {
        expect(result.failure.details).toEqual({ runningContainers: outcome.runningContainers });
        expect(result.failure.message).toContain(`${outcome.runningContainers} containers`);
        expect(result.failure.message).toContain("still running or paused");
      } else {
        // Unknown inventory: describe the read failure; do not invent a known count.
        expect(result.failure.details).toBeUndefined();
        expect(result.failure.message).toContain("could not read the previous runtime's container inventory");
        expect(result.failure.message).not.toMatch(/\d+ containers/);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("refuses to replace a live daemon from another private dir when its API is down", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-xdg-transition-"));
    try {
      const p = paths(dir);
      const calls: Call[] = [];
      await writeFile(p.pidPath, "4321");
      await writeFile(
        `${p.pidPath}.launch.json`,
        JSON.stringify({ pid: 4321, env: { ...canonicalEnv(p), XDG_RUNTIME_DIR: "/old/runtime" } }),
      );
      const result = await Effect.runPromise(
        ensureRuntime({
          ...p,
          platform: "linux",
          serviceRunner: serviceRunner(calls, true),
          podmanApi: {
            ...reachableApi(),
            ping: Effect.fail(unavailable()),
            request: () => Effect.fail(unavailable()),
          },
        }).pipe(Effect.result),
      );
      expect(result._tag).toBe("Failure");
      expectRefusedMutation(calls);
      if (result._tag === "Failure") {
        expect(result.failure.remediation).toBe("Run `lando poweroff`, then rerun the command.");
        expect(result.failure.details).toBeUndefined();
        expect(result.failure.message).toContain("could not read the previous runtime's container inventory");
        expect(result.failure.message).toContain("keeps");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test.each([107, 108, "multibyte"] as const)(
    "checks managed socket UTF-8 bytes before launching: %s",
    async (size) => {
      const dir = await mkdtemp(join(tmpdir(), "lando-socket-limit-"));
      try {
        const calls: Call[] = [];
        const p = {
          ...paths(dir),
          socketPath: size === "multibyte" ? `/${"é".repeat(54)}` : `/${"a".repeat(size - 1)}`,
        };
        const result = await Effect.runPromise(
          ensureRuntime({
            ...p,
            platform: "linux",
            podmanApi: apiReachableAfterLaunch(calls),
            serviceRunner: serviceRunner(calls, false),
          }).pipe(Effect.result),
        );
        if (size === 107) {
          expect(result._tag).toBe("Success");
          expect(terminatedPidSet(calls)).toEqual([]);
          expect(launchCount(calls)).toBe(1);
          await expectPersistedPid(p, 9999);
        } else {
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") {
            expect(maxDataRootBytes).toBe(83);
            expect(result.failure.details).toEqual({
              socketPath: p.socketPath,
              bytes: size === "multibyte" ? 109 : 108,
              limit: MANAGED_SOCKET_PATH_MAX_BYTES,
              maxDataRootBytes,
            });
            expect(result.failure.remediation).toContain("LANDO_USER_DATA_ROOT");
          }
          expectRefusedMutation(calls);
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  test.each([true, false])(
    "an early child exit reports a redacted log and rootless classification (uidmap: %s)",
    async (hasUidmapTools) => {
      const dir = await mkdtemp(join(tmpdir(), "lando-early-exit-"));
      const oldSecret = process.env.LANDO_TEST_SECRET_TOKEN;
      process.env.LANDO_TEST_SECRET_TOKEN = "early-exit-secret";
      try {
        const p = paths(dir);
        const calls: Call[] = [];
        let pings = 0;
        const error = await Effect.runPromise(
          ensureRuntime({
            ...p,
            platform: "linux",
            rootlessProbes: { probe: () => ({ ...allPrereqs(), hasUidmapTools }) },
            serviceRunner: {
              ...serviceRunnerWritingLog(calls, "unknown flag: --root early-exit-secret\n"),
              waitForExit: () => Effect.succeed(125),
            },
            podmanApi: {
              info: Effect.succeed({}),
              ping: Effect.suspend(() => {
                pings += 1;
                return pings === 1 ? Effect.fail(unavailable()) : Effect.never;
              }),
            },
          }).pipe(Effect.flip),
        );
        expect(error.details).toMatchObject({
          exitCode: 125,
          logPath: podmanServiceLogPath(p.socketPath),
        });
        expect(JSON.stringify(error.details)).toContain("unknown flag: --root");
        expect(JSON.stringify(error.details)).not.toContain("early-exit-secret");
        if (!hasUidmapTools) expect(error.details).toMatchObject({ prerequisite: "uidmap-tools" });
        expect(error.remediation).toContain(podmanServiceLogPath(p.socketPath));
        expect(pings).toBe(2);
      } finally {
        if (oldSecret === undefined) Reflect.deleteProperty(process.env, "LANDO_TEST_SECRET_TOKEN");
        else process.env.LANDO_TEST_SECRET_TOKEN = oldSecret;
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  test("persisted launch identity contains only overlay and ignores changed host locale", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-launch-overlay-"));
    const oldLang = process.env.LANG;
    try {
      const p = paths(dir);
      process.env.LANG = "en_US.UTF-8";
      const spec = buildPodmanServiceArgs(p);
      await Effect.runPromise(persistLaunchState(p.pidPath, 4321, spec));
      process.env.LANG = "fr_FR.UTF-8";
      expect(
        await Effect.runPromise(recordedLaunchMatchesSpec(p.pidPath, 4321, buildPodmanServiceArgs(p))),
      ).toBe(true);
      const stored = JSON.parse(await readFile(`${p.pidPath}.launch.json`, "utf8"));
      expect(stored.env).toEqual(spec.env);
      expect(stored.env.LANG).toBeUndefined();
      expect(stored.env.XDG_RUNTIME_DIR).toBeDefined();
    } finally {
      if (oldLang === undefined) Reflect.deleteProperty(process.env, "LANG");
      else process.env.LANG = oldLang;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reachable socket with legacy managed argv stops service before relaunch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-ensure-runtime-"));
    try {
      const calls: Call[] = [];
      const p = paths(dir);

      await Effect.runPromise(
        ensureRuntime({
          platform: "linux",
          podmanApi: reachableApi(),
          serviceRunner: serviceRunner(calls, true, false, {
            findMatchingPids: [],
            findManagedPids: [8888],
          }),
          ...p,
        }),
      );

      expect(terminatedPidSet(calls)).toEqual([8888]);
      expect(launchCount(calls)).toBe(1);
      await expectPersistedPid(p, 9999);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reachable socket without owned argv match relaunches managed service", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-ensure-runtime-"));
    try {
      const calls: Call[] = [];
      const p = paths(dir);

      await Effect.runPromise(
        ensureRuntime({
          platform: "linux",
          podmanApi: reachableApi(),
          serviceRunner: serviceRunner(calls, true, false, { findMatchingPids: [], findManagedPids: [] }),
          ...p,
        }),
      );

      expect(terminatedPidSet(calls)).toEqual([]);
      expect(launchCount(calls)).toBe(1);
      await expectPersistedPid(p, 9999);
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

      expect(terminatedPidSet(calls)).toEqual([]);
      expect(launchCount(calls)).toBe(1);
      await expectPersistedPid(p, 9999);
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
      await writeLaunchState(p, 4321);

      await Effect.runPromise(
        ensureRuntime({
          platform: "linux",
          podmanApi: reachableApi(),
          serviceRunner: serviceRunner(calls, true),
          ...p,
        }),
      );

      expect(terminatedPidSet(calls)).toEqual([]);
      expect(launchCount(calls)).toBe(0);
      await expectPersistedPid(p, 4321);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reachable socket with matching argv but legacy two-key launch env metadata is restarted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-ensure-runtime-"));
    try {
      // Given: a live owned service predates the private XDG config root launch requirement.
      const calls: Call[] = [];
      const p = paths(dir);
      await writeFile(p.pidPath, "4321");
      await writeFile(
        `${p.pidPath}.launch.json`,
        JSON.stringify({
          pid: 4321,
          env: {
            CONTAINERS_CONF: join(p.configDir, "containers.conf"),
            CONTAINERS_REGISTRIES_CONF: join(p.configDir, "registries.conf"),
          },
        }),
      );

      // When: ensureRuntime compares the legacy launch state with the current service spec.
      await Effect.runPromise(
        ensureRuntime({
          platform: "linux",
          podmanApi: reachableApi(),
          serviceRunner: serviceRunner(calls, true),
          ...p,
        }),
      );

      // Then: the legacy service is terminated and relaunched with the current managed env.
      expect(terminatedPidSet(calls)).toEqual([4321]);
      expect(launchCount(calls)).toBe(1);
      await expectPersistedLaunchState(p, 9999);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reachable socket with matching argv but missing launch env metadata is restarted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-ensure-runtime-"));
    try {
      // Given: an old owned service has only the legacy PID file, so its launch
      // env cannot prove the current CONTAINERS_CONF requirement was applied.
      const calls: Call[] = [];
      const p = paths(dir);
      await writeFile(p.pidPath, "4321");

      // When: ensureRuntime sees the socket is already reachable.
      await Effect.runPromise(
        ensureRuntime({
          platform: "linux",
          podmanApi: reachableApi(),
          serviceRunner: serviceRunner(calls, true),
          ...p,
        }),
      );

      // Then: the old owned process is stopped and relaunched with the current spec.
      expect(terminatedPidSet(calls)).toEqual([4321]);
      expect(launchCount(calls)).toBe(1);
      await expectPersistedPid(p, 9999);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reachable socket with matching argv and launch env metadata is reused", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-ensure-runtime-"));
    try {
      // Given: the recorded owned service launch state includes the required env.
      const calls: Call[] = [];
      const p = paths(dir);
      await writeFile(p.pidPath, "4321");
      await writeLaunchState(p, 4321);

      // When: ensureRuntime sees the socket is already reachable.
      await Effect.runPromise(
        ensureRuntime({
          platform: "linux",
          podmanApi: reachableApi(),
          serviceRunner: serviceRunner(calls, true),
          ...p,
        }),
      );

      // Then: no stop/start is performed.
      expect(terminatedPidSet(calls)).toEqual([]);
      expect(launchCount(calls)).toBe(0);
      await expectPersistedPid(p, 4321);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reachable socket is reused when only the host PATH suffix differs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-ensure-runtime-path-suffix-"));
    try {
      // Given: setup recorded PATH as runtime/bin plus one host suffix, and this
      // process would prepend a different host PATH (guide e2e vs setup shell).
      const calls: Call[] = [];
      const p = paths(dir);
      const env = canonicalEnv(p) ?? {};
      const runtimeBin = env.PATH?.split(delimiter)[0];
      if (runtimeBin === undefined) throw new Error("expected managed PATH");
      await writeFile(p.pidPath, "4321");
      await writeFile(
        `${p.pidPath}.launch.json`,
        JSON.stringify({
          pid: 4321,
          env: { ...env, PATH: `${runtimeBin}${delimiter}/usr/bin` },
        }),
      );

      await Effect.runPromise(
        ensureRuntime({
          platform: "linux",
          podmanApi: reachableApi(),
          serviceRunner: serviceRunner(calls, true),
          ...p,
        }),
      );

      expect(terminatedPidSet(calls)).toEqual([]);
      expect(launchCount(calls)).toBe(0);
      await expectPersistedPid(p, 4321);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("setup restarts a healthy service launched from an older runtime bundle", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-ensure-runtime-bundle-upgrade-"));
    try {
      const calls: Call[] = [];
      const p = paths(dir);
      await writeFile(p.pidPath, "4321");
      await writeLaunchState(p, 4321, "1.0.0");

      await Effect.runPromise(
        ensureRuntime({
          platform: "linux",
          podmanApi: reachableApi(),
          serviceRunner: serviceRunner(calls, true),
          runtimeBundleVersion: "2.0.0",
          ...p,
        }),
      );

      expect(terminatedPidSet(calls)).toEqual([4321]);
      expect(launchCount(calls)).toBe(1);
      await expectPersistedLaunchState(p, 9999, "2.0.0");
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
          serviceRunner: serviceRunner(calls, true, false, { findMatchingPids: [], findManagedPids: [] }),
          ...p,
        }),
      );

      expect(terminatedPidSet(calls)).toEqual([]);
      expect(launchCount(calls)).toBe(1);
      await expectPersistedPid(p, 9999);
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
          serviceRunner: serviceRunner(calls, true, false, {
            findMatchingPids: [7777],
            findManagedPids: [],
          }),
          ...p,
        }),
      );

      expect(terminatedPidSet(calls)).toEqual([7777]);
      expect(launchCount(calls)).toBe(1);
      await expectPersistedPid(p, 9999);
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

      expect(terminatedPidSet(calls)).toEqual([]);
      expect(launchCount(calls)).toBe(1);
      await expectPersistedPid(p, 9999);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("terminates a just-spawned service when launch metadata persistence fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-ensure-runtime-metadata-fail-"));
    try {
      const calls: Call[] = [];
      const p = paths(dir);
      const metadataError = new ProviderUnavailableError({
        providerId: "lando",
        operation: "setup",
        message: "simulated metadata write failure",
        remediation: "Install or start the `lando` provider and confirm it can perform `setup`.",
      });

      const exit = await Effect.runPromiseExit(
        ensureRuntime({
          platform: "linux",
          podmanApi: unreachableApi(),
          serviceRunner: serviceRunner(calls, true),
          recordLaunch: () => Effect.fail(metadataError),
          readinessPolicy: fastReadinessPolicy,
          ...p,
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(terminatedPidSet(calls)).toEqual([9999]);
      expect(launchCount(calls)).toBe(1);
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
      // Launched under the current private runtime dir, so replacing it is ordinary recovery.
      await writeLaunchState(p, 4321);

      await Effect.runPromise(
        ensureRuntime({
          platform: "linux",
          podmanApi: apiReachableAfterLaunch(calls),
          serviceRunner: serviceRunner(calls, true),
          ...p,
        }),
      );

      expect(terminatedPidSet(calls)).toEqual([4321]);
      expect(launchCount(calls)).toBe(1);
      await expectMissingFile(p.socketPath);
      await expectPersistedPid(p, 9999);
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

      expect(terminatedPidSet(calls)).toEqual([]);
      expect(launchCount(calls)).toBe(1);
      await expectPersistedPid(p, 9999);
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

      expect(terminatedPidSet(calls)).toEqual([]);
      expect(launchCount(calls)).toBe(1);
      await expectPersistedPid(p, 9999);
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
              subidRangeSufficient: false,
              subidRangesDisjoint: false,
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
        const failure = Cause.findErrorOption(exit.cause);
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
        const failure = Cause.findErrorOption(exit.cause);
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
          readinessPolicy: fastReadinessPolicy,
          ...p,
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(terminatedPidSet(calls)).toEqual([]);
      expect(launchCount(calls)).toBe(1);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
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

  test("launch readiness probes ping without calling info", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-ensure-runtime-"));
    try {
      // Given: libpod info is unavailable, but cheap libpod ping succeeds after launch.
      const calls: Call[] = [];
      const apiCalls: string[] = [];
      const p = paths(dir);
      const podmanApi: PodmanApiClient = {
        info: Effect.sync(() => apiCalls.push("info")).pipe(Effect.andThen(Effect.fail(unavailable()))),
        ping: Effect.sync(() => {
          apiCalls.push("ping");
        }),
      };

      // When: ensuring a Linux runtime launches the managed service.
      await Effect.runPromise(
        ensureRuntime({
          platform: "linux",
          podmanApi,
          serviceRunner: serviceRunner(calls, false),
          readinessPolicy: fastReadinessPolicy,
          ...p,
        }),
      );

      // Then: readiness uses ping only and never invokes expensive info.
      expect(apiCalls).toEqual(["ping", "ping"]);
      expect(terminatedPidSet(calls)).toEqual([]);
      expect(launchCount(calls)).toBe(1);
      await expectPersistedPid(p, 9999);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("launch success surfaces service log tail when the socket never becomes reachable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-ensure-runtime-"));
    try {
      // Given: a launched service writes startup failure evidence before the API probe times out.
      const calls: Call[] = [];
      const p = paths(dir);
      const exit = await Effect.runPromiseExit(
        ensureRuntime({
          platform: "linux",
          podmanApi: unreachableApi(),
          serviceRunner: serviceRunnerWritingLog(calls, "podman died: missing helper\n"),
          readinessPolicy: fastReadinessPolicy,
          ...p,
        }),
      );

      // When/Then: the reachability failure carries the service log tail as stderr evidence.
      expect(Exit.isFailure(exit)).toBe(true);
      expect(terminatedPidSet(calls)).toEqual([]);
      expect(launchCount(calls)).toBe(1);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(ProviderUnavailableError);
          expect(failure.value.message).toContain("did not become reachable");
          expect(failure.value.details).toMatchObject({ stderr: "podman died: missing helper\n" });
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("default readiness budget tolerates a slow cold start beyond the first ten probes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-ensure-runtime-"));
    try {
      const calls: Call[] = [];
      const p = paths(dir);
      const slow = apiReachableAfterAttempts(12);

      await Effect.runPromise(
        ensureRuntime({
          platform: "linux",
          podmanApi: slow.api,
          serviceRunner: serviceRunner(calls, false),
          ...p,
        }),
      );

      expect(slow.attempts()).toBeGreaterThan(10);
      expect(terminatedPidSet(calls)).toEqual([]);
      expect(launchCount(calls)).toBe(1);
      await expectPersistedPid(p, 9999);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);

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
          readinessPolicy: fastReadinessPolicy,
          ...p,
        }),
      );

      expect(calls).toEqual(["inspect", "create", "start"]);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
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

  test("fails closed on Intel macOS before any Podman machine step", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-ensure-runtime-"));
    try {
      const calls: string[] = [];
      const p = paths(dir);
      const exit = await Effect.runPromiseExit(
        ensureRuntime({
          platform: "darwin",
          arch: "x64",
          podmanApi: reachableApi(),
          serviceRunner: throwingLaunchRunner(),
          machineRunner: machineRunner("missing", calls),
          ...p,
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(IntelMacUnsupportedError);
          expect(failure.value._tag).toBe("ProviderUnavailableError");
          expect(failure.value.remediation).toContain("lando setup --provider=docker");
          expect(failure.value.remediation).toContain("LANDO_PROVIDER=docker");
        }
      }
      expect(calls).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("healthy macOS machine also skips the launch lock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-ensure-runtime-mac-healthy-"));
    try {
      const calls: string[] = [];
      let locks = 0;
      await Effect.runPromise(
        ensureRuntime({
          platform: "darwin",
          podmanApi: reachableApi(),
          serviceRunner: throwingLaunchRunner(),
          machineRunner: machineRunner("running", calls),
          withLaunchLock: <A, E>(_body: Effect.Effect<A, E>) =>
            Effect.sync(() => {
              locks += 1;
              throw new Error("healthy runtime must not wait for the launch lock");
            }) as Effect.Effect<A, E>,
          ...paths(dir),
        }),
      );
      expect(locks).toBe(0);
      expect(calls).toEqual(["inspect"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("healthy Windows machine completes setup progress without taking the launch lock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-ensure-runtime-progress-"));
    try {
      const phases: string[] = [];
      await Effect.runPromise(
        ensureRuntime({
          platform: "win32",
          podmanApi: reachableApi(),
          serviceRunner: throwingLaunchRunner(),
          machineRunner: machineRunner("running", []),
          withLaunchLock: (body) =>
            Effect.sync(() => {
              phases.push("lock");
            }).pipe(Effect.andThen(body)),
          setupProgress: {
            launch: (body) =>
              Effect.sync(() => {
                phases.push("launch");
              }).pipe(Effect.andThen(body)),
            readiness: (body) =>
              Effect.sync(() => {
                phases.push("readiness");
              }).pipe(Effect.andThen(body)),
          },
          ...paths(dir),
        }),
      );
      expect(phases).toEqual(["launch", "readiness"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("concurrent Windows commands reuse a healthy runtime without acquiring the launch lock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-ensure-runtime-concurrent-"));
    try {
      const calls: string[] = [];
      let locks = 0;
      let pings = 0;
      let infos = 0;
      const deps = {
        platform: "win32" as const,
        podmanApi: {
          ping: Effect.sync(() => {
            pings += 1;
          }),
          info: Effect.sync(() => {
            infos += 1;
            return {};
          }),
        },
        serviceRunner: throwingLaunchRunner(),
        machineRunner: machineRunner("running", calls),
        withLaunchLock: <A, E>(_body: Effect.Effect<A, E>) =>
          Effect.sync(() => {
            locks += 1;
            throw new Error("healthy runtime must not wait for the launch lock");
          }) as Effect.Effect<A, E>,
        ...paths(dir),
      };

      await Effect.runPromise(
        Effect.all(
          Array.from({ length: 6 }, () => ensureRuntime(deps)),
          {
            concurrency: "unbounded",
            discard: true,
          },
        ),
      );

      expect(locks).toBe(0);
      expect(pings).toBe(6);
      expect(infos).toBe(6);
      expect(calls).toEqual(Array(6).fill("inspect"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reachable Windows API does not bypass the lock for a stopped machine", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-ensure-runtime-stopped-"));
    try {
      const calls: string[] = [];
      let locks = 0;
      await Effect.runPromise(
        ensureRuntime({
          platform: "win32",
          podmanApi: reachableApi(),
          serviceRunner: throwingLaunchRunner(),
          machineRunner: machineRunner("stopped", calls),
          withLaunchLock: (body) =>
            Effect.sync(() => {
              locks += 1;
            }).pipe(Effect.andThen(body)),
          ...paths(dir),
        }),
      );
      expect(locks).toBe(1);
      expect(calls).toEqual(["inspect", "inspect", "inspect", "start"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("Windows cold repair holds the lock and verifies readiness after starting the machine", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-ensure-runtime-cold-"));
    try {
      const calls: string[] = [];
      let running = false;
      let insideLock = false;
      let locks = 0;
      const machine: PodmanMachineRunner = {
        ...machineRunner("stopped", calls),
        inspect: Effect.sync(() => {
          calls.push("inspect");
          return running ? "running" : "stopped";
        }),
        start: Effect.sync(() => {
          expect(insideLock).toBe(true);
          calls.push("start");
          running = true;
        }),
      };
      const api: PodmanApiClient = {
        ping: Effect.suspend(() => (running ? Effect.void : Effect.fail(unavailable()))),
        info: Effect.suspend(() => (running ? Effect.succeed({}) : Effect.fail(unavailable()))),
      };
      await Effect.runPromise(
        ensureRuntime({
          platform: "win32",
          podmanApi: api,
          serviceRunner: throwingLaunchRunner(),
          machineRunner: machine,
          withLaunchLock: (body) =>
            Effect.acquireUseRelease(
              Effect.sync(() => {
                locks += 1;
                insideLock = true;
              }),
              () => body,
              () =>
                Effect.sync(() => {
                  insideLock = false;
                }),
            ),
          ...paths(dir),
        }),
      );
      expect(locks).toBe(1);
      expect(calls).toEqual(["inspect", "start"]);
      expect(running).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("Windows rechecks health under the lock after another command repairs the runtime", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-ensure-runtime-race-"));
    try {
      const calls: string[] = [];
      const phases: string[] = [];
      let running = false;
      let locks = 0;
      const api: PodmanApiClient = {
        ping: Effect.suspend(() => (running ? Effect.void : Effect.fail(unavailable()))),
        info: Effect.suspend(() => (running ? Effect.succeed({}) : Effect.fail(unavailable()))),
      };
      await Effect.runPromise(
        ensureRuntime({
          platform: "win32",
          podmanApi: api,
          serviceRunner: throwingLaunchRunner(),
          machineRunner: machineRunner("running", calls),
          withLaunchLock: (body) =>
            Effect.sync(() => {
              locks += 1;
              running = true;
            }).pipe(Effect.andThen(body)),
          setupProgress: {
            launch: (body) =>
              Effect.sync(() => {
                phases.push("launch");
              }).pipe(Effect.andThen(body)),
            readiness: (body) =>
              Effect.sync(() => {
                phases.push("readiness");
              }).pipe(Effect.andThen(body)),
          },
          ...paths(dir),
        }),
      );
      expect(locks).toBe(1);
      expect(calls).toEqual(["inspect"]);
      expect(phases).toEqual(["launch", "readiness"]);
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

  test("win32 readiness requires both API ping and info after machine start", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-ensure-runtime-"));
    try {
      const calls: string[] = [];
      const apiCalls: string[] = [];
      const p = paths(dir);

      await Effect.runPromise(
        ensureRuntime({
          platform: "win32",
          podmanApi: {
            ping: Effect.sync(() => apiCalls.push("ping")),
            info: Effect.sync(() => {
              apiCalls.push("info");
              return {};
            }),
          },
          serviceRunner: throwingLaunchRunner(),
          machineRunner: machineRunner("missing", calls),
          ...p,
        }),
      );

      expect(calls).toEqual(["inspect", "inspect", "inspect", "create", "start"]);
      expect(apiCalls).toEqual(["ping", "info", "ping", "info", "ping", "info"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("win32 readiness failure names the deterministic Podman pipe", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-ensure-runtime-"));
    try {
      const exit = await Effect.runPromiseExit(
        ensureRuntime({
          platform: "win32",
          podmanApi: unreachableApi(),
          serviceRunner: throwingLaunchRunner(),
          machineRunner: machineRunner("running", []),
          readinessPolicy: fastReadinessPolicy,
          ...paths(dir),
          socketPath: "\\\\.\\pipe\\podman-lando",
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value.message).toContain("\\\\.\\pipe\\podman-lando");
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
