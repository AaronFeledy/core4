import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import {
  managedPodmanChildEnv,
  managedPodmanGlobalArgs,
  managedPodmanOverlayEnv,
  withoutPodmanRedirectsDefined,
} from "@lando/container-runtime/podman/managed-invocation";
import {
  type ManagedRuntimeDirSeams,
  prepareLaunchedManagedRuntimeDir,
} from "@lando/container-runtime/podman/managed-runtime-dir";
import { makeLandoPaths, normalizeHostPlatform, runtimeLayoutPaths } from "@lando/paths";
import { Effect, Result } from "effect";

import { classifyManagedProviderMachine } from "../runtime/managed-provider-machine.ts";
import { uninstallCleanupFailure } from "./uninstall-cleanup-error.ts";

export type RuntimeExec = (
  file: string,
  args: readonly string[],
  options: {
    readonly timeout: number;
    readonly env?: NodeJS.ProcessEnv;
  },
) => Promise<{ readonly stdout: string }>;

type ManagedUninstallSpawn = "linux" | "connection";

export type UninstallRuntime = {
  readonly cmd: string;
  readonly providerId: string;
  readonly managed: boolean;
  readonly argsPrefix: readonly string[];
  /**
   * Managed overlay only (persisted launch identity shape). Never a process.env
   * spread. Linux spawns compose this through managedPodmanChildEnv; connection
   * spawns use redirect denial only (no Linux config overlay).
   */
  readonly env?: Readonly<Record<string, string>>;
  readonly runtimeDir?: string;
  readonly managedSpawn?: ManagedUninstallSpawn;
};

export type UninstallRuntimeSeams = {
  readonly prepareRuntimeDir?: (
    runtimeDir: string,
    seams?: ManagedRuntimeDirSeams,
  ) => Effect.Effect<string, unknown>;
  readonly runtimeDirSeams?: ManagedRuntimeDirSeams;
  readonly hostEnv?: Readonly<Record<string, string | undefined>>;
};

export const defaultRuntimeExec: RuntimeExec = promisify(execFile);

const managedOverlayFor = (
  paths: ReturnType<typeof runtimeLayoutPaths>,
  hostEnv: Readonly<Record<string, string | undefined>>,
  privateRuntimeDir?: string,
): Readonly<Record<string, string>> =>
  managedPodmanOverlayEnv({
    runtimeConfigDir: paths.runtimeConfigDir,
    runtimeBinDir: paths.runtimeBinDir,
    ...(hostEnv.PATH === undefined ? {} : { hostPath: hostEnv.PATH }),
    ...(privateRuntimeDir === undefined ? {} : { privateRuntimeDir }),
  });

const spawnEnvForRuntime = (
  runtime: UninstallRuntime,
  seams: UninstallRuntimeSeams,
): NodeJS.ProcessEnv | undefined => {
  if (!runtime.managed) return undefined;
  const hostEnv = seams.hostEnv ?? process.env;
  // Machine connections must not receive the Linux XDG/config overlay.
  if (runtime.managedSpawn === "connection") {
    return { ...withoutPodmanRedirectsDefined(hostEnv) };
  }
  if (runtime.env === undefined) return undefined;
  return { ...managedPodmanChildEnv(runtime.env, hostEnv) };
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;
    throw cause;
  }
};

const prepareManagedLinuxRuntime = async (
  runtime: UninstallRuntime,
  seams: UninstallRuntimeSeams = {},
): Promise<UninstallRuntime> => {
  if (runtime.managedSpawn !== "linux" || runtime.runtimeDir === undefined) return runtime;
  const prepare = seams.prepareRuntimeDir ?? prepareLaunchedManagedRuntimeDir;
  const prepared = await Effect.runPromise(
    Effect.result(
      prepare(runtime.runtimeDir, {
        ...(seams.runtimeDirSeams ?? {}),
        providerId: runtime.providerId,
      }),
    ),
  );
  if (Result.isFailure(prepared)) {
    throw uninstallCleanupFailure(
      `Cannot prepare the private runtime directory for ${runtime.cmd}; ensure a usable /run/user/$(id -u) or XDG_RUNTIME_DIR, then retry.`,
      prepared.failure,
    );
  }
  const hostEnv = seams.hostEnv ?? process.env;
  const paths = runtimeLayoutPaths(dirname(runtime.runtimeDir));
  return {
    ...runtime,
    env: managedOverlayFor(paths, hostEnv, prepared.success),
  };
};

/**
 * Unmanaged/connection paths call exec synchronously so callers that gate on the
 * first probe still observe the call before the next microtask.
 */
export const runUninstallRuntime = (
  exec: RuntimeExec,
  runtime: UninstallRuntime,
  request: { readonly args: readonly string[]; readonly timeout?: number },
  seams: UninstallRuntimeSeams = {},
): Promise<{ readonly stdout: string }> => {
  const run = (ready: UninstallRuntime): Promise<{ readonly stdout: string }> => {
    const env = spawnEnvForRuntime(ready, seams);
    return exec(ready.cmd, [...ready.argsPrefix, ...request.args], {
      timeout: request.timeout ?? 5_000,
      ...(env === undefined ? {} : { env }),
    });
  };
  if (runtime.managed && runtime.managedSpawn === "linux" && runtime.runtimeDir !== undefined) {
    return prepareManagedLinuxRuntime(runtime, seams).then(run);
  }
  return run(runtime);
};

export const uninstallRuntimes = (
  userDataRoot: string,
  platform: NodeJS.Platform,
  hostEnv: Readonly<Record<string, string | undefined>> = process.env,
): readonly UninstallRuntime[] => {
  const paths = makeLandoPaths({ userDataRoot });
  const managedSpawn: ManagedUninstallSpawn = platform === "linux" ? "linux" : "connection";
  const managedBase = {
    cmd: join(paths.runtimeBinDir, platform === "win32" ? "podman.exe" : "podman"),
    providerId: "lando" as const,
    managed: true as const,
    managedSpawn,
  };
  return [
    { cmd: "docker", providerId: "docker", managed: false, argsPrefix: [] },
    { cmd: "podman", providerId: "podman", managed: false, argsPrefix: [] },
    managedSpawn === "linux"
      ? {
          ...managedBase,
          runtimeDir: paths.runtimeDir,
          argsPrefix: managedPodmanGlobalArgs({
            runtimeStorageDir: paths.runtimeStorageDir,
            runtimeRunDir: paths.runtimeRunDir,
            runtimeConfigDir: paths.runtimeConfigDir,
            runtimeBinDir: paths.runtimeBinDir,
          }),
          // Overlay without private dir; runUninstallRuntime prepares XDG_RUNTIME_DIR.
          env: managedOverlayFor(paths, hostEnv),
        }
      : {
          ...managedBase,
          argsPrefix: ["--connection", "lando-root"],
        },
  ];
};

export const availableUninstallRuntimes = async (input: {
  readonly userDataRoot: string;
  readonly platform: NodeJS.Platform;
  readonly exec: RuntimeExec;
  readonly seams?: UninstallRuntimeSeams;
}): Promise<readonly UninstallRuntime[]> => {
  const seams = input.seams ?? {};
  const hostEnv = seams.hostEnv ?? process.env;
  const available: UninstallRuntime[] = [];
  for (const base of uninstallRuntimes(input.userDataRoot, input.platform, hostEnv)) {
    let runtime = base;
    try {
      // Missing managed tree: probe without prepare so absence does not require XDG.
      if (
        runtime.managed &&
        runtime.managedSpawn === "linux" &&
        runtime.runtimeDir !== undefined &&
        !(await pathExists(runtime.runtimeDir))
      ) {
        await input.exec(runtime.cmd, [...runtime.argsPrefix, "--version"], { timeout: 2_000 });
        available.push(runtime);
        continue;
      }
      await runUninstallRuntime(input.exec, runtime, { args: ["--version"], timeout: 2_000 }, seams);
      if (runtime.managed && runtime.managedSpawn === "linux" && runtime.runtimeDir !== undefined) {
        runtime = await prepareManagedLinuxRuntime(runtime, seams);
      }
      available.push(runtime);
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) {
        throw uninstallCleanupFailure(
          `Cannot query installed runtime ${runtime.cmd}; preserve runtime storage and retry.`,
          cause,
        );
      }
      if (!runtime.managed) continue;
      const paths = makeLandoPaths({ userDataRoot: input.userDataRoot });
      try {
        await access(paths.runtimeDir);
      } catch (storageCause) {
        if (!(storageCause instanceof Error && "code" in storageCause && storageCause.code === "ENOENT"))
          throw storageCause;
        const machine = classifyManagedProviderMachine(
          input.userDataRoot,
          undefined,
          normalizeHostPlatform({ platform: input.platform }),
        );
        if (machine.ownership === "absent") continue;
        throw uninstallCleanupFailure(
          "Cannot inspect the recorded Windows managed machine because its Podman binary is missing; preserve its machine and state.",
          cause,
        );
      }
      throw uninstallCleanupFailure(
        "Cannot inspect existing managed runtime storage because its Podman binary is missing; preserve storage and state.",
        cause,
      );
    }
  }
  return available;
};
