import { managedPodmanOverlayEnv } from "@lando/container-runtime/podman/managed-invocation";

import { buildManagedRuntimeServiceArgs } from "./managed-runtime-service.ts";

export interface PodmanServiceSpec {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
  readonly socketPath: string;
  readonly cwd?: string;
}

const runtimeBinDirFromPodman = (podmanBin: string): string | undefined => {
  const separator = podmanBin.lastIndexOf("/");
  return separator > 0 ? podmanBin.slice(0, separator) : undefined;
};

export const buildPodmanServiceArgs = (p: {
  readonly podmanBin: string;
  readonly storageDir: string;
  readonly runRoot: string;
  readonly configDir: string;
  readonly socketPath: string;
  readonly useSystemdRunShim?: boolean;
  readonly privateRuntimeDir: string | undefined;
}): PodmanServiceSpec => {
  const runtimeBinDir = runtimeBinDirFromPodman(p.podmanBin);
  // Always prepend the runtime bin so netavark can exec the bundled nft helper.
  // The systemd-run shim (when present) lives in the same directory.
  return {
    command: p.podmanBin,
    env: managedPodmanOverlayEnv({
      runtimeConfigDir: p.configDir,
      ...(runtimeBinDir === undefined ? {} : { runtimeBinDir }),
      ...(p.privateRuntimeDir === undefined ? {} : { privateRuntimeDir: p.privateRuntimeDir }),
      ...(process.env.PATH === undefined ? {} : { hostPath: process.env.PATH }),
    }),
    args: buildManagedRuntimeServiceArgs({
      runtimeStorageDir: p.storageDir,
      runtimeRunDir: p.runRoot,
      runtimeConfigDir: p.configDir,
      ...(runtimeBinDir === undefined ? {} : { runtimeBinDir }),
      providerSocketPath: p.socketPath,
    }),
    socketPath: p.socketPath,
    // conmon getcwd() fails if the daemon inherited a CLI cwd that later vanished
    // (guide e2e temp dirs, `cd`+rm). Bind the service to the durable run root.
    cwd: p.runRoot,
  };
};
