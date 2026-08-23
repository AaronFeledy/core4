import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  UNINSTALL_RUNTIME_DIR_LEFTOVER_MESSAGE,
  formatUninstallRuntimeDirStepError,
  leftoverUninstallRuntimeDirError,
  preferLeftoverRuntimePath,
  uninstallRuntimeDirRemediation,
} from "../../src/operations/uninstall-runtime-error.ts";

describe("preferLeftoverRuntimePath", () => {
  test("prefers a volume file under storage/volumes over runtimeDir", () => {
    // Given: a runtime tree with a nested volume leftover
    const root = mkdtempSync(join(tmpdir(), "lando-uninstall-leftover-vol-"));
    try {
      const runtimeDir = join(root, "runtime");
      const volumeFile = join(runtimeDir, "storage", "volumes", "app", "data.img");
      mkdirSync(join(runtimeDir, "storage", "volumes", "app"), { recursive: true });
      writeFileSync(volumeFile, "blob");

      // When: preferring a leftover path
      const preferred = preferLeftoverRuntimePath(runtimeDir, existsSync);

      // Then: the volume file is preferred over runtimeDir
      expect(preferred).toBe(volumeFile);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns the volumes path when volumes is not a directory", () => {
    // Given: storage/volumes is a file so readdirSync throws ENOTDIR
    const root = mkdtempSync(join(tmpdir(), "lando-uninstall-leftover-file-"));
    try {
      const runtimeDir = join(root, "runtime");
      const volumesAsFile = join(runtimeDir, "storage", "volumes");
      mkdirSync(join(runtimeDir, "storage"), { recursive: true });
      writeFileSync(volumesAsFile, "not-a-dir");

      // When: preferring a leftover path
      const preferred = preferLeftoverRuntimePath(runtimeDir, existsSync);

      // Then: the unlistable volumes path is returned
      expect(preferred).toBe(volumesAsFile);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns runtimeDir when storage/volumes is absent", () => {
    // Given: a runtime dir with no volumes tree
    const root = mkdtempSync(join(tmpdir(), "lando-uninstall-leftover-none-"));
    try {
      const runtimeDir = join(root, "runtime");
      mkdirSync(runtimeDir, { recursive: true });

      // When: preferring a leftover path
      const preferred = preferLeftoverRuntimePath(runtimeDir, existsSync);

      // Then: runtimeDir is used
      expect(preferred).toBe(runtimeDir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("uninstallRuntimeDirRemediation", () => {
  test("uses managed podman unshare when managed podman exists", () => {
    // Given / When / Then
    expect(uninstallRuntimeDirRemediation("/rt/storage/volumes/x", true, "/rt/bin/podman")).toBe(
      "Run `CONTAINERS_CONF=/rt/config/containers.conf /rt/bin/podman --config /rt/config unshare rm -rf /rt/storage/volumes/x` then rerun `lando uninstall --purge --yes`.",
    );
  });

  test("uses sudo rm when managed podman is absent", () => {
    // Given / When / Then
    expect(uninstallRuntimeDirRemediation("/rt/storage/volumes/x", false, "/rt/bin/podman")).toBe(
      "Run `sudo rm -rf /rt/storage/volumes/x` then rerun `lando uninstall --purge --yes`.",
    );
  });
});

describe("leftoverUninstallRuntimeDirError", () => {
  test("builds UninstallRuntimeDirError with leftover tag and message", () => {
    // Given: no volumes under runtimeDir
    const runtimeDir = "/tmp/lando-runtime-leftover-tag";
    const exists = (path: string): boolean => path === runtimeDir;

    // When: building the leftover error
    const error = leftoverUninstallRuntimeDirError(runtimeDir, exists);

    // Then: tagged error with leftover message
    expect(error._tag).toBe("UninstallRuntimeDirError");
    expect(error.message).toBe(UNINSTALL_RUNTIME_DIR_LEFTOVER_MESSAGE);
    expect(error.path).toBe(runtimeDir);
  });
});

describe("formatUninstallRuntimeDirStepError", () => {
  test("formats message path and remediation", () => {
    // Given: a leftover error with sudo remediation
    const runtimeDir = "/tmp/lando-runtime-format";
    const exists = (path: string): boolean => path === runtimeDir;
    const error = leftoverUninstallRuntimeDirError(runtimeDir, exists);
    const remediation = uninstallRuntimeDirRemediation(runtimeDir, false, join(runtimeDir, "bin", "podman"));

    // When: formatting for a step error string
    const formatted = formatUninstallRuntimeDirStepError(error);

    // Then: shape is message (path). remediation
    expect(formatted).toBe(`${UNINSTALL_RUNTIME_DIR_LEFTOVER_MESSAGE} (${runtimeDir}). ${remediation}`);
  });
});
