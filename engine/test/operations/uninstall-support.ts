import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { UninstallOptions } from "../../src/operations/uninstall.ts";
import {
  type RemoveRuntimeDirDeps,
  defaultRemoveRuntimeDir,
} from "../../src/operations/uninstall-runtime-dir.ts";

export const privateRuntimeTestDeps = (runtimeDir: string): RemoveRuntimeDirDeps => {
  const privateDir = join(dirname(runtimeDir), "test-session-runtime");
  return {
    resolvePrivateRuntimeDir: async () => privateDir,
    preparePrivateRuntimeDir: async () => {
      mkdirSync(privateDir, { recursive: true, mode: 0o700 });
      return privateDir;
    },
    terminatePause: async () => undefined,
  };
};

export const makeUninstallRoots = (prefix = "lando-uninstall-") => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return {
    root,
    userDataRoot: join(root, "data"),
    userCacheRoot: join(root, "cache"),
    userConfRoot: join(root, "config"),
    cgroupsDelegatePath: join(root, "delegate.conf"),
    shellProfilePath: join(root, ".profile"),
  };
};

export const sandboxUninstallOptions = (
  roots: ReturnType<typeof makeUninstallRoots>,
  extra: UninstallOptions = {},
): UninstallOptions => ({
  userDataRoot: roots.userDataRoot,
  userCacheRoot: roots.userCacheRoot,
  userConfRoot: roots.userConfRoot,
  cgroupsDelegatePath: roots.cgroupsDelegatePath,
  shellProfilePath: roots.shellProfilePath,
  listDiscoveredApps: async () => [],
  remove: (path) =>
    path === join(roots.userDataRoot, "runtime")
      ? defaultRemoveRuntimeDir(path, privateRuntimeTestDeps(path))
      : rm(path, { recursive: true, force: true }),
  ...extra,
});

export const writeManagedVolumeTree = (runtimeDir: string): string => {
  const file = join(runtimeDir, "storage", "volumes", "app-mariadb-data", "_data", "ibdata1");
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
