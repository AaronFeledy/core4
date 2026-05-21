import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit } from "effect";

import { makeLandoRuntime } from "@lando/core";
import {
  config,
  invokeOperation,
  listServices,
  renderAppsListResult,
  renderConfigResult,
} from "@lando/core/cli/operations";

import corePackage from "../../package.json";

const repoRoot = resolve(import.meta.dirname, "../../..");
const coreRoot = resolve(import.meta.dirname, "../..");

describe("@lando/core/cli/operations package export", () => {
  test("resolves from the workspace package name", async () => {
    const operations = await import("@lando/core/cli/operations");

    expect(operations.invokeOperation).toBeFunction();
    expect(operations.listServices).toBeFunction();
    expect(corePackage.exports["./cli/operations"]).toBe("./src/cli/operations.ts");
    expect(Bun.resolveSync("@lando/core/cli/operations", repoRoot)).toBe(
      join(coreRoot, "src/cli/operations.ts"),
    );
  });

  test("invokes supported commands without spawning and returns render/error payloads", async () => {
    const userDataRoot = await mkdtemp(join(tmpdir(), "lando-operations-data-"));
    const userCacheRoot = await mkdtemp(join(tmpdir(), "lando-operations-cache-"));
    const userConfRoot = await mkdtemp(join(tmpdir(), "lando-operations-conf-"));
    const previousUserConfRoot = process.env.LANDO_USER_CONF_ROOT;
    const previousUserDataRoot = process.env.LANDO_USER_DATA_ROOT;

    try {
      process.env.LANDO_USER_CONF_ROOT = userConfRoot;
      process.env.LANDO_USER_DATA_ROOT = userDataRoot;
      const runtime = makeLandoRuntime({
        bootstrap: "minimal",
      });

      const result = await Effect.runPromise(
        invokeOperation(listServices({ userCacheRoot }), { render: renderAppsListResult }).pipe(
          Effect.provide(runtime),
        ),
      );

      expect(result).toEqual({
        ok: true,
        value: { apps: [] },
        output: "No Lando apps applied on this host.",
      });

      const failure = await Effect.runPromise(
        invokeOperation(config({ subcommand: "set" }), {
          render: renderConfigResult,
          renderError: (error) => error.message,
        }).pipe(Effect.provide(runtime)),
      );

      expect(failure.ok).toBe(false);
      if (!failure.ok) {
        expect(failure.error._tag).toBe("NotImplementedError");
        expect(failure.output).toContain("deferred to Beta");
      }
    } finally {
      // biome-ignore lint/performance/noDelete: environment cleanup must remove variables when originally unset.
      if (previousUserConfRoot === undefined) delete process.env.LANDO_USER_CONF_ROOT;
      else process.env.LANDO_USER_CONF_ROOT = previousUserConfRoot;
      // biome-ignore lint/performance/noDelete: environment cleanup must remove variables when originally unset.
      if (previousUserDataRoot === undefined) delete process.env.LANDO_USER_DATA_ROOT;
      else process.env.LANDO_USER_DATA_ROOT = previousUserDataRoot;
      await rm(userDataRoot, { recursive: true, force: true });
      await rm(userCacheRoot, { recursive: true, force: true });
      await rm(userConfRoot, { recursive: true, force: true });
    }
  });

  test("propagates defects and interrupts instead of classifying them as typed failures", async () => {
    const defect = new Error("boom");
    const defectExit = await Effect.runPromiseExit(invokeOperation(Effect.die(defect)));
    expect(Exit.isFailure(defectExit)).toBe(true);
    if (Exit.isFailure(defectExit)) {
      expect(Cause.dieOption(defectExit.cause)._tag).toBe("Some");
    }

    const interruptExit = await Effect.runPromiseExit(invokeOperation(Effect.interrupt));
    expect(Exit.isFailure(interruptExit)).toBe(true);
    if (Exit.isFailure(interruptExit)) {
      expect(Cause.failureOption(interruptExit.cause)._tag).toBe("None");
    }

    const mixedExit = await Effect.runPromiseExit(
      invokeOperation(
        Effect.failCause(Cause.parallel(Cause.fail("typed-error"), Cause.die(new Error("inner-defect")))),
      ),
    );
    expect(Exit.isFailure(mixedExit)).toBe(true);
  });
});
