import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { EngineHttpApi } from "@lando/container-runtime/engine-api";
import { makePodmanApiClient } from "@lando/container-runtime/podman/api-client";
import {
  isManagedPodmanLaunchStage,
  managedPodmanGlobalArgs,
} from "@lando/container-runtime/podman/managed-invocation";
import {
  managedRuntimeDirForTeardown,
  terminateManagedPause,
} from "@lando/container-runtime/podman/managed-runtime-dir";
import { type RetryPolicy, runProbe } from "@lando/sdk/probe";
import { type HostPlatform, hostPlatformFamily } from "@lando/sdk/schema";
import { Duration, Effect, Schema } from "effect";
import {
  type ExecConmonReaper,
  managedConmonPathForPodman,
  reapLingeringExecConmons,
} from "./exec-conmon.ts";
import { providerContextForEnv } from "./provider-context.ts";

export interface ManagedRuntimeServicePaths {
  readonly platform: HostPlatform;
  readonly runtimeBinDir: string;
  readonly runtimeRunDir: string;
  readonly runtimeStorageDir: string;
  readonly runtimeConfigDir: string;
  readonly providerSocketPath: string;
  readonly providerPidPath: string;
}

export interface ManagedRuntimeServiceSpec {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly socketPath: string;
  readonly pidPath: string;
}

export interface ManagedRuntimeServiceArgsParts {
  readonly runtimeStorageDir: string;
  readonly runtimeRunDir: string;
  readonly runtimeConfigDir: string;
  readonly runtimeBinDir?: string;
  readonly providerSocketPath: string;
}

export interface ProcessSeam {
  readonly readPid: (pidPath: string) => Effect.Effect<string, unknown>;
  readonly isAlive: (pid: number) => Effect.Effect<boolean, unknown>;
  readonly readCmdline: (pid: number) => Effect.Effect<ReadonlyArray<string>, unknown>;
  readonly terminate: (pid: number) => Effect.Effect<void, unknown>;
}

export interface FsSeam {
  readonly unlink: (path: string) => Effect.Effect<void, unknown>;
}

export interface RuntimeServiceSeams {
  readonly process?: ProcessSeam;
  readonly fs?: FsSeam;
  readonly execConmon?: ExecConmonReaper;
  readonly apiClient?: (socketPath: string) => EngineHttpApi;
  readonly terminationPolicy?: RetryPolicy;
  readonly privateRuntimeDir?: (runtimeDir: string) => Effect.Effect<string | undefined>;
  readonly terminatePause?: (privateRuntimeDir: string) => Effect.Effect<boolean>;
}

type TerminationResult = { readonly terminated: boolean; readonly pid?: number; readonly quiescent?: true };

const pidPattern = /^\d+$/u;
const emptyArgv: ReadonlyArray<string> = [];

const realProcessSeam: ProcessSeam = {
  readPid: (pidPath) =>
    Effect.tryPromise({
      try: () => readFile(pidPath, "utf8"),
      catch: (cause) => cause,
    }),
  isAlive: (pid) =>
    Effect.sync(() => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (cause: unknown) {
        void cause;
        return false;
      }
    }),
  readCmdline: (pid) =>
    Effect.tryPromise({
      try: async () => {
        const raw = await readFile(`/proc/${pid}/cmdline`, "utf8");
        return raw.split("\0").filter((part) => part.length > 0);
      },
      catch: (cause) => cause,
    }),
  terminate: (pid) =>
    Effect.try({
      try: () => {
        process.kill(pid, "SIGTERM");
      },
      catch: (cause) => cause,
    }),
};

const realFsSeam: FsSeam = {
  unlink: (path) =>
    Effect.tryPromise({
      try: () => rm(path, { force: true }),
      catch: (cause) => cause,
    }),
};

const parsePid = (raw: string): number | undefined => {
  const trimmed = raw.trim();
  if (!pidPattern.test(trimmed)) return undefined;

  const pid = Number(trimmed);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
};

const ownedRuntimePid = Effect.fnUntraced(function* (
  spec: ManagedRuntimeServiceSpec,
  processSeam: ProcessSeam,
): Effect.fn.Return<number | undefined> {
  const rawPid = yield* processSeam.readPid(spec.pidPath).pipe(Effect.catch(() => Effect.succeed(undefined)));
  if (rawPid === undefined) return undefined;

  const pid = parsePid(rawPid);
  if (pid === undefined) return undefined;

  const alive = yield* processSeam.isAlive(pid).pipe(Effect.catch(() => Effect.succeed(false)));
  if (!alive) return undefined;

  const argv = yield* processSeam.readCmdline(pid).pipe(Effect.catch(() => Effect.succeed(emptyArgv)));
  return isManagedPodmanLaunchStage(argv, [spec.command, ...spec.args]) ? pid : undefined;
});

const bestEffortUnlink = (fsSeam: FsSeam, path: string): Effect.Effect<void> =>
  fsSeam.unlink(path).pipe(Effect.catch(() => Effect.void));

export const buildManagedRuntimeServiceArgs = (
  parts: ManagedRuntimeServiceArgsParts,
): ReadonlyArray<string> => {
  return [
    ...managedPodmanGlobalArgs(parts),
    "system",
    "service",
    "--time=0",
    `unix://${parts.providerSocketPath}`,
  ];
};

// Forward slash is intentional: this is the exact argv[0] the provider spawns and
// the same string matched against `/proc/<pid>/cmdline`, so it must not be re-normalized.
export const managedRuntimePodmanArgv0 = (runtimeBinDir: string, platform: HostPlatform): string =>
  `${runtimeBinDir}/${hostPlatformFamily(platform) === "win32" ? "podman.exe" : "podman"}`;

export const buildManagedRuntimeServiceSpec = (
  paths: ManagedRuntimeServicePaths,
): ManagedRuntimeServiceSpec => ({
  command: managedRuntimePodmanArgv0(paths.runtimeBinDir, paths.platform),
  args: buildManagedRuntimeServiceArgs(paths),
  socketPath: paths.providerSocketPath,
  pidPath: paths.providerPidPath,
});

export const verifyOwnedRuntimePid = (
  spec: ManagedRuntimeServiceSpec,
  processSeam: ProcessSeam = realProcessSeam,
): Effect.Effect<boolean> => ownedRuntimePid(spec, processSeam).pipe(Effect.map((pid) => pid !== undefined));

const defaultApiClient = (socketPath: string): EngineHttpApi =>
  makePodmanApiClient(socketPath, providerContextForEnv({ ...process.env }));

const StorageContainers = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ Id: Schema.String, State: Schema.optionalKey(Schema.String) })),
);

/**
 * A FROM-only, failed, or interrupted build can leave its working container in
 * storage with the rootfs still mounted, and each mount keeps a fuse-overlayfs
 * helper alive after the service exits. Removing those storage-only containers
 * through the service unmounts them; Podman-managed containers are left alone.
 */
const reclaimLeftoverBuildContainers = Effect.fnUntraced(function* (api: EngineHttpApi) {
  const request = api.request;
  if (request === undefined) return;
  const response = yield* request({ method: "GET", path: "/libpod/containers/json?all=true&external=true" });
  if (response.status < 200 || response.status >= 300) return;
  const containers = yield* Schema.decodeUnknownEffect(StorageContainers)(response.body);
  yield* Effect.forEach(
    containers.filter((container) => container.State === "storage"),
    (container) =>
      request({
        method: "DELETE",
        path: `/libpod/containers/${encodeURIComponent(container.Id)}?force=true`,
      }).pipe(Effect.catch(() => Effect.void)),
    { discard: true },
  );
});

export const terminateOwnedRuntimeService = Effect.fn("ProviderLando.terminateOwnedRuntimeService")(
  function* (
    spec: ManagedRuntimeServiceSpec,
    seams: RuntimeServiceSeams = {},
  ): Effect.fn.Return<TerminationResult> {
    const processSeam = seams.process ?? realProcessSeam;
    const fsSeam = seams.fs ?? realFsSeam;

    const pid = yield* ownedRuntimePid(spec, processSeam);
    let quiescent = false;
    let exited = false;
    const result = yield* Effect.gen(function* () {
      if (pid === undefined) return { terminated: false };

      const api = (seams.apiClient ?? defaultApiClient)(spec.socketPath);
      quiescent = yield* Effect.gen(function* () {
        yield* reclaimLeftoverBuildContainers(api);
        if (api.request === undefined) return false;
        const response = yield* api.request({ method: "GET", path: "/libpod/containers/json?all=true" });
        if (response.status < 200 || response.status >= 300) return false;
        const containers = yield* Schema.decodeUnknownEffect(StorageContainers)(response.body);
        return containers.every(
          (container) =>
            container.State !== undefined && !["running", "paused", "created"].includes(container.State),
        );
      }).pipe(
        Effect.timeout("10 seconds"),
        Effect.catch(() => Effect.succeed(false)),
      );

      const terminated = yield* processSeam.terminate(pid).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      );
      if (terminated) {
        const probe = yield* runProbe(
          {
            id: `provider-lando-teardown-${pid}`,
            policy: seams.terminationPolicy ?? {
              maxAttempts: 61,
              delay: Duration.millis(250),
              timeout: Duration.seconds(15),
            },
            classify: { success: (alive) => (alive ? "red" : "green"), failure: () => "red" },
          },
          processSeam.isAlive(pid),
        ).pipe(Effect.catch(() => Effect.succeed(undefined)));
        exited = probe?.outcome === "green";
      }
      return terminated ? { terminated: true, pid } : { terminated: false, pid };
    });

    if (result.terminated && exited) {
      yield* bestEffortUnlink(fsSeam, spec.socketPath);
      yield* bestEffortUnlink(fsSeam, spec.pidPath);
    }

    yield* reapLingeringExecConmons({
      conmonPath: managedConmonPathForPodman(spec.command),
      ...(seams.execConmon === undefined ? {} : { reaper: seams.execConmon }),
    });

    if (quiescent && exited) {
      const runtimeDir = dirname(dirname(spec.command));
      const privateDir = yield* (seams.privateRuntimeDir ?? managedRuntimeDirForTeardown)(runtimeDir);
      if (privateDir === undefined) return result;
      const pause = yield* (seams.terminatePause ?? terminateManagedPause)(privateDir);
      if (pause === false) return result;
      return { ...result, quiescent: true };
    }

    return result;
  },
);
