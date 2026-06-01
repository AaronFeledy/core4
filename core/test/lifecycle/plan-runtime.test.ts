import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit } from "effect";

import { withProcessCwd } from "../../src/lifecycle/plan-runtime.ts";

const withTempDir = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-plan-runtime-")));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

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
