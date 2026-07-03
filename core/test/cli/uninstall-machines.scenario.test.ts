import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { formatUninstallResult } from "../../src/cli/commands/uninstall.ts";
import { metaUninstallSpec } from "../../src/cli/oclif/commands/meta/uninstall.ts";

const seedSetupState = (userDataRoot: string, machine: unknown): void => {
  const dir = join(userDataRoot, "providers", "provider-lando");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "setup-state.json"), JSON.stringify({ podmanVersion: "5.2.0", machine }), "utf-8");
};

const makeRoots = () => {
  const root = mkdtempSync(join(tmpdir(), "lando-uninstall-machine-scenario-"));
  const userDataRoot = join(root, "data");
  mkdirSync(userDataRoot, { recursive: true });
  return { root, userDataRoot, userCacheRoot: join(root, "cache") };
};

describe("lando uninstall provider-machine teardown (scenario)", () => {
  test("owned machine recorded in real setup state is torn down and reported removed", async () => {
    const { root, userDataRoot, userCacheRoot } = makeRoots();
    try {
      seedSetupState(userDataRoot, { name: "lando", createdByLando: true });
      const teardownRoots: string[] = [];

      const result = await Effect.runPromise(
        metaUninstallSpec.run({
          flags: { yes: true, "keep-data": true },
          _userDataRoot: userDataRoot,
          _userCacheRoot: userCacheRoot,
          _execPath: join(root, "lando"),
          _exists: () => false,
          _remove: async () => {},
          _teardownProviderMachines: async (rootPath: string) => {
            teardownRoots.push(rootPath);
            return { removed: true, name: "lando" };
          },
        }),
      );

      const step = result.steps.find((s) => s.id === "managed-provider-machines");
      expect(step).toMatchObject({ status: "owned", outcome: "completed" });
      expect(teardownRoots).toEqual([userDataRoot]);
      const output = formatUninstallResult(result);
      expect(output).toContain("managed provider machines");
      expect(output).toContain("[completed]");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("machine adopted from a pre-existing VM is skipped with remediation", async () => {
    const { root, userDataRoot, userCacheRoot } = makeRoots();
    try {
      seedSetupState(userDataRoot, { name: "lando", createdByLando: false });
      let teardownCalled = false;

      const result = await Effect.runPromise(
        metaUninstallSpec.run({
          flags: { yes: true, "keep-data": true },
          _userDataRoot: userDataRoot,
          _userCacheRoot: userCacheRoot,
          _execPath: join(root, "lando"),
          _exists: () => false,
          _remove: async () => {},
          _teardownProviderMachines: async () => {
            teardownCalled = true;
            return { removed: false };
          },
        }),
      );

      expect(result.steps.find((s) => s.id === "managed-provider-machines")).toMatchObject({
        status: "user-owned",
        outcome: "manual",
      });
      expect(teardownCalled).toBe(false);
      expect(formatUninstallResult(result)).toContain("not created by Lando");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("machine teardown failure is recorded in the resumable report", async () => {
    const { root, userDataRoot, userCacheRoot } = makeRoots();
    try {
      seedSetupState(userDataRoot, { name: "lando", createdByLando: true });

      const result = await Effect.runPromise(
        metaUninstallSpec.run({
          flags: { yes: true, "keep-data": true },
          _userDataRoot: userDataRoot,
          _userCacheRoot: userCacheRoot,
          _execPath: join(root, "lando"),
          _exists: () => false,
          _remove: async () => {},
          _teardownProviderMachines: async () => {
            throw new Error("Run 'podman machine rm --force lando' manually. (exit 1: boom)");
          },
        }),
      );

      expect(result.failed).toBe(true);
      expect(result.reportPath).toBe(join(userDataRoot, "uninstall", "report.json"));
      const report = JSON.parse(readFileSync(result.reportPath as string, "utf-8"));
      const step = report.steps.find((s: { readonly id: string }) => s.id === "managed-provider-machines");
      expect(step.outcome).toBe("failed");
      expect(step.error).toContain("podman machine rm");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
