import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
