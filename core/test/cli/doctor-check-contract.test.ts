import { describe, expect, test } from "bun:test";
import { type Context, Effect, Layer } from "effect";

import { ConfigService, RuntimeProviderRegistry } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/core/testing";
import { type GlobalConfig, ProviderId } from "@lando/sdk/schema";
import type { RuntimeProviderShape } from "@lando/sdk/services";
import {
  type DoctorCheckContractHarness,
  DoctorCheckError,
  type DoctorCheckIssue,
  type DoctorCheckResult,
  runDoctorCheckContractSuite,
} from "@lando/sdk/test";

import { type DoctorCheck, doctor } from "../../src/cli/commands/doctor.ts";

/**
 * DoctorCheck built-in invocation.
 *
 * Core ships built-in checks for app config and selected-provider basics.
 * Rather than fabricate a standalone `DoctorCheckShape`, this file adapts the
 * real `doctor()` command's `selected-provider` check (run against
 * `TestRuntimeProvider`) into the published `DoctorCheckContractHarness` shape,
 * so the layer-coverage gate has a built-in invocation that exercises the
 * actual shipped diagnostic rather than a mock.
 *
 * The core `DoctorCheck` severity vocabulary (`info` | `warn` | `error`) is
 * mapped to the SDK contract vocabulary (`info` | `warning` | `error`) and the
 * core `DoctorSolution.kind` (`automatic` | `manual`) maps directly to the SDK
 * `solutionKind`. A check with no remediation reports no issues (a healthy run).
 */

const buildRegistry = (provider: RuntimeProviderShape) => ({
  list: Effect.succeed([ProviderId.make(provider.id)]),
  capabilities: Effect.succeed(provider.capabilities),
  select: () => Effect.succeed(provider),
});

const buildConfigService = (): Context.Tag.Service<typeof ConfigService> => {
  const config: GlobalConfig = {
    defaultProviderId: ProviderId.make("lando"),
    telemetry: { enabled: false },
  } as GlobalConfig;
  const load = Effect.succeed(config);
  return {
    load,
    get: (key) => Effect.map(load, (loadedConfig) => loadedConfig[key]),
  };
};

const buildLayers = (provider: RuntimeProviderShape): Layer.Layer<ConfigService | RuntimeProviderRegistry> =>
  Layer.merge(
    Layer.succeed(RuntimeProviderRegistry, buildRegistry(provider)),
    Layer.succeed(ConfigService, buildConfigService()),
  );

const mapSeverity = (severity: DoctorCheck["severity"]): DoctorCheckIssue["severity"] =>
  severity === "warn" ? "warning" : severity;

/**
 * Adapt a core `selected-provider` `DoctorCheck` into the SDK contract's
 * `DoctorCheckResult`. A check with no solutions is healthy (no issues).
 */
const toDoctorCheckResult = (check: DoctorCheck): DoctorCheckResult => ({
  id: check.name,
  issues: check.solutions.map(
    (solution): DoctorCheckIssue => ({
      severity: mapSeverity(check.severity),
      context: check.context,
      solutionKind: solution.kind,
      solution: solution.description,
      ...(solution.command === undefined ? {} : { command: solution.command }),
    }),
  ),
});

/**
 * Run the real `doctor()` command against the given provider and project its
 * `selected-provider` check into the SDK contract's check shape. The `fix`
 * argument is accepted to satisfy the harness; `doctor()` itself is read-only
 * (it never mutates host state to produce the selected-provider diagnosis).
 */
const selectedProviderCheck = (provider: RuntimeProviderShape) => ({
  id: "selected-provider",
  run: (_input: { readonly fix: boolean }) =>
    doctor()
      .pipe(Effect.provide(buildLayers(provider)))
      .pipe(
        Effect.map((result) => {
          const check = result.checks.find((candidate) => candidate.name === "selected-provider");
          if (check === undefined) {
            return { id: "selected-provider", issues: [] } satisfies DoctorCheckResult;
          }
          return toDoctorCheckResult(check);
        }),
        Effect.mapError(
          (cause) =>
            new DoctorCheckError({
              message: "selected-provider doctor check failed",
              check: "selected-provider",
              cause,
            }),
        ),
      ),
});

const runningProvider: RuntimeProviderShape = {
  ...TestRuntimeProvider,
  id: "lando",
  getStatus: Effect.succeed({ running: true, message: "ready" }),
};

const stoppedProvider: RuntimeProviderShape = {
  ...TestRuntimeProvider,
  id: "lando",
  getStatus: Effect.succeed({ running: false, message: "stopped" }),
};

describe("DoctorCheck contract — built-in selected-provider check", () => {
  test("a healthy selected-provider run passes the contract (no issues)", async () => {
    const harness: DoctorCheckContractHarness = {
      name: "selected-provider (running)",
      check: selectedProviderCheck(runningProvider),
    };
    const exit = await Effect.runPromiseExit(runDoctorCheckContractSuite(harness));
    if (exit._tag === "Failure") {
      throw new Error(`Contract failure: ${JSON.stringify(exit.cause, null, 2)}`);
    }
    expect(exit._tag).toBe("Success");
  });

  test("a stopped provider reports a warning with a manual remediation", async () => {
    const harness: DoctorCheckContractHarness = {
      name: "selected-provider (stopped)",
      check: selectedProviderCheck(stoppedProvider),
      expectedIssue: { severity: "warning", contextKey: "providerId", solutionKind: "manual" },
    };
    const exit = await Effect.runPromiseExit(runDoctorCheckContractSuite(harness));
    if (exit._tag === "Failure") {
      throw new Error(`Contract failure: ${JSON.stringify(exit.cause, null, 2)}`);
    }
    expect(exit._tag).toBe("Success");
  });

  test("the selected-provider check is read-only by default", async () => {
    // `doctor()` produces the selected-provider diagnosis without executing any
    // remediation; a default run reports the same issues twice (deterministic,
    // no mutation between runs).
    const check = selectedProviderCheck(stoppedProvider);
    const first = await Effect.runPromise(check.run({ fix: false }));
    const second = await Effect.runPromise(check.run({ fix: false }));
    expect(second).toEqual(first);
    expect(first.issues[0]?.solutionKind).toBe("manual");
  });
});
