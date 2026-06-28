import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { uninstall } from "../../src/cli/commands/uninstall.ts";

const makeRoots = () => {
  const root = mkdtempSync(join(tmpdir(), "lando-uninstall-runtime-service-test-"));
  const userDataRoot = join(root, "data");
  const userCacheRoot = join(root, "cache");
  return { root, userDataRoot, userCacheRoot };
};

describe("runtime-service uninstall execution", () => {
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
});
