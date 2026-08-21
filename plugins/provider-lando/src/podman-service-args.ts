import { delimiter } from "node:path";

import { buildManagedRuntimeServiceArgs } from "./managed-runtime-service.ts";
import { hasUsableUserSystemdSession } from "./user-systemd-session.ts";

export interface PodmanServiceSpec {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
  readonly socketPath: string;
}

const runtimeBinDirFromPodman = (podmanBin: string): string | undefined => {
  const separator = podmanBin.lastIndexOf("/");
  return separator > 0 ? podmanBin.slice(0, separator) : undefined;
};

const managedServicePath = (runtimeBinDir: string | undefined): string | undefined => {
  const hostPath = process.env.PATH ?? "";
  if (runtimeBinDir === undefined) return hostPath.length > 0 ? hostPath : undefined;
  if (hostPath.length === 0) return runtimeBinDir;
  return `${runtimeBinDir}${delimiter}${hostPath}`;
};

export const buildPodmanServiceArgs = (p: {
  readonly podmanBin: string;
  readonly storageDir: string;
  readonly runRoot: string;
  readonly configDir: string;
  readonly socketPath: string;
  readonly useSystemdRunShim?: boolean;
}): PodmanServiceSpec => {
  const runtimeBinDir = runtimeBinDirFromPodman(p.podmanBin);
  const useShim = p.useSystemdRunShim ?? !hasUsableUserSystemdSession();
  const pathValue = useShim ? managedServicePath(runtimeBinDir) : undefined;
  return {
    command: p.podmanBin,
    env: {
      CONTAINERS_CONF: `${p.configDir}/containers.conf`,
      CONTAINERS_REGISTRIES_CONF: `${p.configDir}/registries.conf`,
      XDG_CONFIG_HOME: p.configDir,
      DISABLE_HC_SYSTEMD: "true",
      ...(pathValue === undefined ? {} : { PATH: pathValue }),
    },
    args: buildManagedRuntimeServiceArgs({
      runtimeStorageDir: p.storageDir,
      runtimeRunDir: p.runRoot,
      runtimeConfigDir: p.configDir,
      ...(runtimeBinDir === undefined ? {} : { runtimeBinDir }),
      providerSocketPath: p.socketPath,
    }),
    socketPath: p.socketPath,
  };
};
