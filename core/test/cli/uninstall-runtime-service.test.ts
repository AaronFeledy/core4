import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer } from "effect";

import type { HostMaintenanceContribution } from "@lando/sdk/plugins";

import { uninstall } from "../../src/testing/engine-layers.ts";
import { HostMaintenanceRegistry } from "../../src/testing/engine-layers.ts";

const makeRoots = () => {
  const root = mkdtempSync(join(tmpdir(), "lando-uninstall-runtime-service-test-"));
  const userDataRoot = join(root, "data");
  const userCacheRoot = join(root, "cache");
  return { root, userDataRoot, userCacheRoot };
};

const sandboxUninstallIo = (root: string) => ({
  cgroupsDelegatePath: join(root, "delegate.conf"),
  shellProfilePath: join(root, ".profile"),
});

describe("runtime-service uninstall execution", () => {
  test("runs teardown from the host maintenance registry", async () => {
    // Given: an owned runtime directory and a host maintainer fake.
    const { root, userDataRoot, userCacheRoot } = makeRoots();
    const teardownInputs: Parameters<HostMaintenanceContribution["teardown"]>[0][] = [];
    const maintainer: HostMaintenanceContribution = {
      id: "fake-runtime",
      teardown: (input) => {
        teardownInputs.push(input);
        return Effect.succeed({ terminated: true, pid: 9876 });
      },
    };
    try {
      mkdirSync(join(userDataRoot, "runtime"), { recursive: true });

      // When: uninstall executes with the registry supplied.
      const result = await Effect.runPromise(
        uninstall({
          yes: true,
          keepData: true,
          userDataRoot,
          userCacheRoot,
          execPath: join(root, "lando"),
          ...sandboxUninstallIo(root),
        }).pipe(Effect.provide(Layer.succeed(HostMaintenanceRegistry, { maintainers: [maintainer] }))),
      );

      // Then: canonical paths reach the maintainer and teardown completes.
      expect(teardownInputs).toHaveLength(1);
      expect(teardownInputs[0]?.paths.providerPidPath).toBe(
        join(userDataRoot, "runtime", "run", "podman.pid"),
      );
      expect(result.steps.find((step) => step.id === "runtime-service")).toMatchObject({
        outcome: "completed",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("skips host maintenance when the registry is absent", async () => {
    // Given: an owned runtime directory without a host maintenance registry.
    const { root, userDataRoot, userCacheRoot } = makeRoots();
    try {
      mkdirSync(join(userDataRoot, "runtime"), { recursive: true });

      // When: uninstall executes its default runtime teardown seam.
      const result = await Effect.runPromise(
        uninstall({
          yes: true,
          keepData: true,
          userDataRoot,
          userCacheRoot,
          execPath: join(root, "lando"),
          ...sandboxUninstallIo(root),
        }),
      );

      // Then: absence is a safe skipped teardown and uninstall continues.
      expect(result.failed).toBe(false);
      expect(result.steps.find((step) => step.id === "runtime-service")).toMatchObject({
        outcome: "completed",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("removes runtime artifacts when no owned runtime service is running", async () => {
    const { root, userDataRoot, userCacheRoot } = makeRoots();
    try {
      const runtimeDir = join(userDataRoot, "runtime");
      mkdirSync(runtimeDir, { recursive: true });
      const removed: string[] = [];

      const result = await Effect.runPromise(
        uninstall({
          yes: true,
          keepData: true,
          userDataRoot,
          userCacheRoot,
          execPath: join(root, "lando"),
          ...sandboxUninstallIo(root),
          teardownRuntimeService: async () => ({ terminated: false }),
          remove: async (path: string) => {
            removed.push(path);
            rmSync(path, { recursive: true, force: true });
          },
        }),
      );

      expect(result.failed).toBe(false);
      expect(result.steps.find((step) => step.id === "runtime-service")).toMatchObject({
        outcome: "completed",
      });
      expect(removed).toContain(runtimeDir);
      expect(existsSync(runtimeDir)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("must terminate a detected runtime service before removing runtime artifacts", async () => {
    const { root, userDataRoot, userCacheRoot } = makeRoots();
    try {
      const runtimeDir = join(userDataRoot, "runtime");
      mkdirSync(runtimeDir, { recursive: true });
      const removed: string[] = [];

      const result = await Effect.runPromise(
        uninstall({
          yes: true,
          keepData: true,
          userDataRoot,
          userCacheRoot,
          execPath: join(root, "lando"),
          ...sandboxUninstallIo(root),
          teardownRuntimeService: async () => ({ terminated: false, pid: 1234 }),
          remove: async (path: string) => {
            removed.push(path);
            rmSync(path, { recursive: true, force: true });
          },
        }),
      );

      expect(result.failed).toBe(true);
      expect(result.steps.find((step) => step.id === "runtime-service")).toMatchObject({
        outcome: "failed",
        error: "managed runtime service was not terminated",
      });
      expect(removed).not.toContain(runtimeDir);
      expect(existsSync(runtimeDir)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails closed when the runtime directory still exists after removal", async () => {
    const { root, userDataRoot, userCacheRoot } = makeRoots();
    try {
      const runtimeDir = join(userDataRoot, "runtime");
      mkdirSync(runtimeDir, { recursive: true });

      const result = await Effect.runPromise(
        uninstall({
          yes: true,
          keepData: true,
          userDataRoot,
          userCacheRoot,
          execPath: join(root, "lando"),
          ...sandboxUninstallIo(root),
          teardownRuntimeService: async () => ({ terminated: false }),
          remove: async () => {
            // Leave the runtime directory in place.
          },
        }),
      );

      expect(existsSync(runtimeDir)).toBe(true);
      expect(result.failed).toBe(true);
      expect(result.steps.find((step) => step.id === "runtime-service")).toMatchObject({
        outcome: "failed",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
