import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { UninstallOptions } from "../../src/operations/uninstall.ts";

export const makeUninstallRoots = (prefix = "lando-uninstall-") => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return {
    root,
    userDataRoot: join(root, "data"),
    userCacheRoot: join(root, "cache"),
    cgroupsDelegatePath: join(root, "delegate.conf"),
    shellProfilePath: join(root, ".profile"),
    execPath: join(root, "lando"),
  };
};

export const sandboxUninstallOptions = (
  roots: ReturnType<typeof makeUninstallRoots>,
  extra: UninstallOptions = {},
): UninstallOptions => ({
  userDataRoot: roots.userDataRoot,
  userCacheRoot: roots.userCacheRoot,
  execPath: roots.execPath,
  cgroupsDelegatePath: roots.cgroupsDelegatePath,
  shellProfilePath: roots.shellProfilePath,
  ...extra,
});

export const managedVolumeDataFile = (runtimeDir: string): string =>
  join(runtimeDir, "storage", "volumes", "app-mariadb-data", "_data", "ibdata1");

export const writeManagedVolumeTree = (runtimeDir: string): string => {
  const file = managedVolumeDataFile(runtimeDir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "mariadb-data");
  return file;
};

export const writeFakeManagedPodman = (binDir: string, scriptBody: string): string => {
  mkdirSync(binDir, { recursive: true });
  const podman = join(binDir, "podman");
  writeFileSync(podman, scriptBody, { mode: 0o755 });
  return podman;
};
