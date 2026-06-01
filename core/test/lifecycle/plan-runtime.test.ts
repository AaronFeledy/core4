import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, DateTime, Effect, Exit } from "effect";

import { AbsolutePath, AppId, type AppPlan, ProviderId } from "@lando/core/schema";

import { loadPlanFromRenderedFile, withProcessCwd } from "../../src/lifecycle/plan-runtime.ts";

const withTempDir = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-plan-runtime-")));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const plan = (name: string, root: string): AppPlan => ({
  id: AppId.make(name),
  name,
  slug: name,
  root: AbsolutePath.make(root),
  provider: ProviderId.make("lando"),
  services: {},
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata: {
    resolvedAt: DateTime.unsafeMake("2026-05-31T00:00:00Z"),
    source: "plan-runtime.test",
    runtime: 4,
  },
  extensions: {},
});

describe("withProcessCwd", () => {
  test("runs the effect in the requested directory and restores the original cwd", async () => {
    await withTempDir(async (dir) => {
      const original = process.cwd();

      const observed = await Effect.runPromise(
        withProcessCwd(dir, () => Effect.sync(() => process.cwd()), {
          onEnterError: (cause) => ({ _tag: "CwdError" as const, cause }),
        }),
      );

      expect(observed).toBe(dir);
      expect(process.cwd()).toBe(original);
    });
  });

  test("maps chdir failures and leaves cwd unchanged", async () => {
    await withTempDir(async (dir) => {
      const original = process.cwd();
      const exit = await Effect.runPromiseExit(
        withProcessCwd(join(dir, "missing"), () => Effect.succeed("unreachable"), {
          onEnterError: (cause) => ({ _tag: "CwdError" as const, cause }),
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") expect(failure.value._tag).toBe("CwdError");
      }
      expect(process.cwd()).toBe(original);
    });
  });
});

describe("loadPlanFromRenderedFile", () => {
  test("reads and decodes a rendered Landofile, then plans under its root", async () => {
    await withTempDir(async (dir) => {
      let plannedCwd = "";
      const loaded = await Effect.runPromise(
        loadPlanFromRenderedFile({
          file: join(dir, ".lando.yml"),
          cwd: dir,
          read: Effect.succeed("name: rendered\nruntime: 4\nservices: {}\n"),
          decode: ({ content }) =>
            Effect.succeed({ name: content.includes("rendered") ? "rendered" : "missing", runtime: 4 }),
          prepareLandofile: (landofile) => ({ ...landofile, name: "scratch-rendered" }),
          plan: (landofile) =>
            Effect.sync(() => {
              plannedCwd = process.cwd();
              return plan(landofile.name ?? "missing", process.cwd());
            }),
          onEnterCwdError: (cause) => ({ _tag: "CwdError" as const, cause }),
        }),
      );

      expect(loaded.landofile.name).toBe("rendered");
      expect(loaded.landofileForPlan.name).toBe("scratch-rendered");
      expect(loaded.plan.name).toBe("scratch-rendered");
      expect(String(loaded.plan.root)).toBe(dir);
      expect(plannedCwd).toBe(dir);
    });
  });
});
