import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { makeLandoPaths, normalizeHostPlatform } from "@lando/paths";
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

export type UninstallRuntime = {
  readonly cmd: string;
  readonly providerId: string;
  readonly managed: boolean;
  readonly argsPrefix: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
};

export const defaultRuntimeExec: RuntimeExec = promisify(execFile);

export const runUninstallRuntime = (
  exec: RuntimeExec,
  runtime: UninstallRuntime,
  request: { readonly args: readonly string[]; readonly timeout?: number },
) =>
  exec(runtime.cmd, [...runtime.argsPrefix, ...request.args], {
    timeout: request.timeout ?? 5_000,
    ...(runtime.env === undefined ? {} : { env: { ...process.env, ...runtime.env } }),
  });

export const uninstallRuntimes = (
  userDataRoot: string,
  platform: NodeJS.Platform,
): readonly UninstallRuntime[] => {
  const paths = makeLandoPaths({ userDataRoot });
  return [
    { cmd: "docker", providerId: "docker", managed: false, argsPrefix: [] },
    { cmd: "podman", providerId: "podman", managed: false, argsPrefix: [] },
    {
      cmd: join(paths.runtimeBinDir, platform === "win32" ? "podman.exe" : "podman"),
      providerId: "lando",
      managed: true,
      argsPrefix:
        platform === "win32"
          ? ["--connection", "lando-root"]
          : [
              "--root",
              paths.runtimeStorageDir,
              "--runroot",
              paths.runtimeRunDir,
              "--config",
              paths.runtimeConfigDir,
              "--storage-opt",
              `overlay.mount_program=${paths.runtimeBinDir}/fuse-overlayfs`,
            ],
      env: {
        CONTAINERS_CONF: join(paths.runtimeConfigDir, "containers.conf"),
        CONTAINERS_REGISTRIES_CONF: join(paths.runtimeConfigDir, "registries.conf"),
        XDG_CONFIG_HOME: paths.runtimeConfigDir,
      },
    },
  ];
};

export const availableUninstallRuntimes = async (input: {
  readonly userDataRoot: string;
  readonly platform: NodeJS.Platform;
  readonly exec: RuntimeExec;
}): Promise<readonly UninstallRuntime[]> => {
  const available: UninstallRuntime[] = [];
  for (const runtime of uninstallRuntimes(input.userDataRoot, input.platform)) {
    try {
      await runUninstallRuntime(input.exec, runtime, { args: ["--version"], timeout: 2_000 });
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
