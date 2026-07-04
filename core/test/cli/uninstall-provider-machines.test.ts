import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { buildUninstallPlan, formatUninstallResult, uninstall } from "../../src/cli/commands/uninstall.ts";
import type { ManagedProviderMachineClassification } from "../../src/runtime/managed-provider-machine.ts";

const makeRoots = () => {
  const root = mkdtempSync(join(tmpdir(), "lando-uninstall-machine-"));
  return { root, userDataRoot: join(root, "data"), userCacheRoot: join(root, "cache") };
};

const classifyingAs =
  (classification: ManagedProviderMachineClassification) => (): ManagedProviderMachineClassification =>
    classification;

describe("uninstall managed provider machines", () => {
  test("plan marks the machine step owned when setup state records a Lando-created machine", () => {
    const { root, userDataRoot, userCacheRoot } = makeRoots();
    try {
      const plan = buildUninstallPlan({
        userDataRoot,
        userCacheRoot,
        execPath: join(root, "lando"),
        exists: () => false,
        readManagedProviderMachine: classifyingAs({ ownership: "owned", name: "lando" }),
      });

      expect(plan.find((step) => step.id === "managed-provider-machines")).toMatchObject({
        status: "owned",
        target: "lando",
        destructive: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("owned machine is torn down and never removed as a filesystem path", async () => {
    const { root, userDataRoot, userCacheRoot } = makeRoots();
    try {
      const teardownRoots: string[] = [];
      const removed: string[] = [];

      const result = await Effect.runPromise(
        uninstall({
          yes: true,
          keepData: true,
          userDataRoot,
          userCacheRoot,
          execPath: join(root, "lando"),
          exists: () => false,
          readManagedProviderMachine: classifyingAs({ ownership: "owned", name: "lando" }),
          teardownProviderMachines: async (rootPath: string) => {
            teardownRoots.push(rootPath);
            return { removed: true, name: "lando" };
          },
          remove: async (path: string) => {
            removed.push(path);
          },
        }),
      );

      expect(result.steps.find((step) => step.id === "managed-provider-machines")).toMatchObject({
        outcome: "completed",
      });
      expect(teardownRoots).toEqual([userDataRoot]);
      expect(removed).not.toContain("lando");
      expect(result.failed).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("not-owned machine is left untouched with manual remediation", async () => {
    const { root, userDataRoot, userCacheRoot } = makeRoots();
    try {
      let teardownCalled = false;

      const result = await Effect.runPromise(
        uninstall({
          yes: true,
          keepData: true,
          userDataRoot,
          userCacheRoot,
          execPath: join(root, "lando"),
          exists: () => false,
          readManagedProviderMachine: classifyingAs({ ownership: "not-owned", name: "lando" }),
          teardownProviderMachines: async () => {
            teardownCalled = true;
            return { removed: false };
          },
          remove: async () => {},
        }),
      );

      const step = result.steps.find((s) => s.id === "managed-provider-machines");
      expect(step).toMatchObject({ status: "user-owned", outcome: "manual" });
      expect(teardownCalled).toBe(false);
      expect(formatUninstallResult(result)).toContain("not created by Lando");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ambiguous ownership degrades to manual remediation", async () => {
    const { root, userDataRoot, userCacheRoot } = makeRoots();
    try {
      let teardownCalled = false;

      const result = await Effect.runPromise(
        uninstall({
          yes: true,
          purge: true,
          userDataRoot,
          userCacheRoot,
          execPath: join(root, "lando"),
          exists: () => false,
          readManagedProviderMachine: classifyingAs({ ownership: "ambiguous" }),
          teardownProviderMachines: async () => {
            teardownCalled = true;
            return { removed: false };
          },
          remove: async () => {},
        }),
      );

      expect(result.steps.find((s) => s.id === "managed-provider-machines")).toMatchObject({
        status: "manual",
        outcome: "manual",
      });
      expect(teardownCalled).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("absent machine record skips the step", () => {
    const { root, userDataRoot, userCacheRoot } = makeRoots();
    try {
      const plan = buildUninstallPlan(
        {
          userDataRoot,
          userCacheRoot,
          execPath: join(root, "lando"),
          exists: () => false,
          readManagedProviderMachine: classifyingAs({ ownership: "absent" }),
        },
        "purge",
      );

      expect(plan.find((step) => step.id === "managed-provider-machines")).toMatchObject({
        status: "skipped",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rerun after the machine is already gone converges without error", async () => {
    const { root, userDataRoot, userCacheRoot } = makeRoots();
    try {
      const result = await Effect.runPromise(
        uninstall({
          yes: true,
          keepData: true,
          userDataRoot,
          userCacheRoot,
          execPath: join(root, "lando"),
          exists: () => false,
          readManagedProviderMachine: classifyingAs({ ownership: "owned", name: "lando" }),
          // Machine already removed by a prior run: teardown resolves with removed:false.
          teardownProviderMachines: async () => ({ removed: false, name: "lando" }),
          remove: async () => {},
        }),
      );

      expect(result.failed).toBe(false);
      expect(result.steps.find((s) => s.id === "managed-provider-machines")).toMatchObject({
        outcome: "completed",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("machine teardown failure is recorded with remediation", async () => {
    const { root, userDataRoot, userCacheRoot } = makeRoots();
    try {
      const result = await Effect.runPromise(
        uninstall({
          yes: true,
          keepData: true,
          userDataRoot,
          userCacheRoot,
          execPath: join(root, "lando"),
          exists: () => false,
          readManagedProviderMachine: classifyingAs({ ownership: "owned", name: "lando" }),
          teardownProviderMachines: async () => {
            throw new Error("Run 'podman machine rm --force lando' manually. (exit 1: boom)");
          },
          remove: async () => {},
        }),
      );

      expect(result.failed).toBe(true);
      const step = result.steps.find((s) => s.id === "managed-provider-machines");
      expect(step).toMatchObject({ outcome: "failed" });
      expect(step?.error).toContain("podman machine rm");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
