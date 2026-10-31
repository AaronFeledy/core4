import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Result } from "effect";

import { describe, expect, test } from "bun:test";
import { FailureRoleAnnotation } from "@lando/sdk/command-result";
import { Cause, Context, Effect, Exit } from "effect";

import { makeLandoRuntime } from "@lando/core";
import {
  ConfigResultSchema,
  config,
  globalDisable,
  globalEnable,
  globalReconcile,
  invokeOperation,
  listServices,
  renderAppsListResult,
  renderConfigResult,
  renderGlobalPolicyChangeResult,
} from "@lando/core/cli/operations";

import corePackage from "../../package.json";

const repoRoot = resolve(import.meta.dirname, "../../..");
const coreRoot = resolve(import.meta.dirname, "../..");

describe("@lando/core/cli/operations update exports", () => {
  test("exposes the self-update operation contract", async () => {
    const operations = await import("@lando/core/cli/operations");

    expect(operations.update).toBeFunction();
    expect(operations.UpdateResultSchema).toBeDefined();
    expect(operations.resolveUpdateManifestUrl).toBeFunction();
    expect(operations.updateChannelForVersion).toBeFunction();
    expect(operations.buildWindowsReplacementScript).toBeFunction();
    expect(operations.scheduleWindowsReplacement).toBeFunction();
    expect(operations.UpdateNetworkError).toBeFunction();
    expect(operations.UpdateSignatureVerificationError).toBeFunction();
    expect(operations.UpdateMinimumVersionError).toBeFunction();
    expect(operations.UpdateDowngradeError).toBeFunction();
    expect(operations.UpdateManifestReplayError).toBeFunction();
    expect(operations.UpdateChecksumSignatureVerificationError).toBeFunction();
    expect(operations.UpdateChecksumVerificationError).toBeFunction();
    expect(operations.UpdateLaunchProbeError).toBeFunction();
    expect(operations.UpdatePermissionError).toBeFunction();
  });
});

describe("@lando/core/cli/operations package export", () => {
  test("exposes the config operation and renderer contract", async () => {
    const operations = await import("@lando/core/cli/operations");

    expect(operations.config).toBe(config);
    expect(operations.ConfigResultSchema).toBe(ConfigResultSchema);
    expect(operations.renderConfigResult).toBe(renderConfigResult);
  });

  test("exposes the config translate operation", async () => {
    const operations = await import("@lando/core/cli/operations");

    expect(operations.appConfigTranslate).toBeFunction();
  });

  test("exposes the config explain operation", async () => {
    const operations = await import("@lando/core/cli/operations");

    expect(operations.appConfigExplain).toBeFunction();
    expect(operations.renderAppConfigExplainResult).toBeFunction();
  });

  test("resolves from the workspace package name", async () => {
    const operations = await import("@lando/core/cli/operations");

    expect(operations.invokeOperation).toBeFunction();
    expect(operations.listServices).toBeFunction();
    expect(operations.globalEnable).toBe(globalEnable);
    expect(operations.globalDisable).toBe(globalDisable);
    expect(operations.globalReconcile).toBe(globalReconcile);
    expect(operations.renderGlobalPolicyChangeResult).toBe(renderGlobalPolicyChangeResult);
    expect(corePackage.exports["./cli/operations"]).toEqual({
      types: "./src/cli/operations.ts",
      import: "./src/cli/operations.ts",
    });
    expect(await realpath(Bun.resolveSync("@lando/core/cli/operations", repoRoot))).toBe(
      await realpath(join(coreRoot, "src/cli/operations.ts")),
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
        invokeOperation(listServices({ userCacheRoot, userDataRoot, discoverContainers: async () => [] }), {
          render: renderAppsListResult,
        }).pipe(Effect.provide(runtime)),
      );

      expect(result).toEqual({
        ok: true,
        value: { apps: [] },
        output: "No Lando apps applied on this host.",
      });

      const failure = await Effect.runPromise(
        invokeOperation(config({ subcommand: "translate" }), {
          render: renderConfigResult,
          renderError: (error) => error.message,
        }).pipe(Effect.provide(runtime)),
      );

      expect(failure.ok).toBe(false);
      if (!failure.ok) {
        expect(failure.error._tag).toBe("NotImplementedError");
        expect(failure.output).toContain("is not available here");
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
      expect(Result.getSuccess(Cause.findDefect(defectExit.cause))._tag).toBe("Some");
    }

    const interruptExit = await Effect.runPromiseExit(invokeOperation(Effect.interrupt));
    expect(Exit.isFailure(interruptExit)).toBe(true);
    if (Exit.isFailure(interruptExit)) {
      expect(Cause.findErrorOption(interruptExit.cause)._tag).toBe("None");
    }
  });

  test("classifies the projected primary by reason kind, not by value equality", async () => {
    // Given: a typed failure whose value is not equal to itself.
    const nan = await Effect.runPromise(invokeOperation(Effect.fail(Number.NaN)));
    // Then: it still returns as a typed failure.
    expect(nan).toMatchObject({ ok: false, additionalErrors: [] });

    // Given: an unannotated defect and a rollback failure that carry the same value.
    const shared = { _tag: "Shared" };
    const rollback = Cause.annotate(Cause.fail(shared), Context.make(FailureRoleAnnotation, "rollback"));
    // When: invokeOperation observes the combined cause.
    const exit = await Effect.runPromiseExit(
      invokeOperation(Effect.failCause(Cause.combine(Cause.die(shared), rollback))),
    );
    // Then: the primary is the defect, so the cause propagates instead of returning a typed failure.
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("returns typed primary and additional defect for a combined cause", async () => {
    // Given: a typed operation failure and a cleanup defect.
    const defect = new Error("inner-defect");
    // When: invokeOperation observes the combined cause.
    const result = await Effect.runPromise(
      invokeOperation(Effect.failCause(Cause.combine(Cause.fail("typed-error"), Cause.die(defect)))),
    );
    // Then: defects alongside a typed failure are returned as additional errors.
    expect(result).toEqual({
      ok: false,
      error: "typed-error",
      additionalErrors: [{ role: "peer", error: defect }],
    });
  });
});
