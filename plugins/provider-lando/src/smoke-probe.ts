import { randomUUID } from "node:crypto";
import { mapFailures } from "@lando/sdk/command-result";

import { Effect, type Schema, type Scope } from "effect";

import { redactDetails, standaloneSecretsRedactor } from "@lando/container-runtime/redact";
import { type ProbeResult, runProbe } from "@lando/sdk/probe";
import {
  DEFAULT_BASE_IMAGE,
  ProviderLandoSmokeError,
  type SmokeProbeDeps,
  acquireSmokeContainer,
  defaultSmokeRetryPolicy,
  ensureSmokeBaseImage,
  expectSmokeSuccess,
  parseSmokeExitCode,
  parseSmokeHealth,
  removeSmokeResource,
  smokeApiRequest,
  smokeBuildContext,
  smokeImageExists,
  smokeRemediation,
  startSmokeContainer,
} from "./smoke-probe-support.ts";

const hostSecretsRedactor = () => standaloneSecretsRedactor({ ...process.env });

const failureFromResult = (
  operation: "run" | "build" | "health",
  result: ProbeResult,
  details: Readonly<Record<string, Schema.Json>> = {},
) => {
  const operationDetails =
    result.lastError instanceof ProviderLandoSmokeError &&
    typeof result.lastError.details === "object" &&
    result.lastError.details !== null
      ? result.lastError.details
      : {};
  return new ProviderLandoSmokeError({
    smokeOperation: operation,
    message: `The provider-lando ${operation} smoke probe did not complete successfully.`,
    remediation: smokeRemediation(operation),
    details: {
      ...operationDetails,
      ...details,
      attempts: result.attempts,
      elapsedMs: result.elapsedMs,
      outcome: result.outcome,
      ...(result.lastError === undefined
        ? {}
        : { lastError: redactDetails(result.lastError, hostSecretsRedactor()) }),
    },
    ...(result.lastError === undefined ? {} : { cause: result.lastError }),
  });
};

const requireGreen = (operation: "run" | "build" | "health", result: ProbeResult) =>
  result.outcome === "green" ? Effect.void : Effect.fail(failureFromResult(operation, result));

const mapProbeError = (operation: "run" | "build" | "health") => (cause: unknown) =>
  cause instanceof ProviderLandoSmokeError
    ? cause
    : new ProviderLandoSmokeError({
        smokeOperation: operation,
        message: `The provider-lando ${operation} smoke probe could not run.`,
        remediation: smokeRemediation(operation),
        details: redactDetails(cause, hostSecretsRedactor()),
        cause,
      });

export const runContainerSmokeProbe = (deps: SmokeProbeDeps, image: string) =>
  runProbe(
    { id: "provider-lando-smoke-run", policy: deps.retryPolicy ?? defaultSmokeRetryPolicy },
    Effect.scoped(
      Effect.gen(function* () {
        const name = `provider-lando-smoke-run-${randomUUID()}`;
        yield* acquireSmokeContainer(deps, {
          operation: "run",
          name,
          body: { Image: image, Cmd: ["sh", "-c", "exit 0"], HostConfig: { Init: true } },
        });
        yield* startSmokeContainer(deps, "run", name);
        const response = yield* smokeApiRequest(deps, "run", {
          method: "POST",
          path: `/containers/${encodeURIComponent(name)}/wait`,
        }).pipe(
          Effect.flatMap((value) =>
            expectSmokeSuccess("run", value, "Podman could not wait for the run smoke container."),
          ),
        );
        const exitCode = parseSmokeExitCode(response.body);
        if (exitCode === 0) return;
        return yield* Effect.fail(
          new ProviderLandoSmokeError({
            smokeOperation: "run",
            message: `The Podman run smoke container exited with code ${String(exitCode ?? "unknown")}.`,
            remediation: smokeRemediation("run"),
            details: exitCode === undefined ? {} : { exitCode },
          }),
        );
      }),
    ),
  ).pipe(
    mapFailures(mapProbeError("run")),
    Effect.flatMap((result) => requireGreen("run", result)),
  );

export const runBuildSmokeProbe = (deps: SmokeProbeDeps, baseImage: string) => {
  const image = `provider-lando-smoke-build:${randomUUID()}`;
  const cleanup = removeSmokeResource(deps, "build", `/images/${encodeURIComponent(image)}?force=true`);
  const buildParams = new URLSearchParams({ t: image, dockerfile: "Dockerfile", forcerm: "true" });
  const attempt = smokeApiRequest(deps, "build", {
    method: "POST",
    path: `/build?${buildParams.toString()}`,
    headers: { "Content-Type": "application/x-tar" },
    stdin: smokeBuildContext(baseImage),
  }).pipe(
    Effect.flatMap((response) =>
      expectSmokeSuccess("build", response, "Podman could not build the smoke image."),
    ),
    Effect.flatMap(() => smokeImageExists(deps, image, "build")),
    Effect.flatMap((exists) =>
      exists
        ? Effect.void
        : Effect.fail(
            new ProviderLandoSmokeError({
              smokeOperation: "build",
              message: "Podman completed the smoke build but could not resolve the resulting image.",
              remediation: smokeRemediation("build"),
              details: { image },
            }),
          ),
    ),
    Effect.ensuring(cleanup),
  );
  return runProbe(
    { id: "provider-lando-smoke-build", policy: deps.retryPolicy ?? defaultSmokeRetryPolicy },
    attempt,
  ).pipe(
    mapFailures(mapProbeError("build")),
    Effect.flatMap((result) => requireGreen("build", result)),
  );
};

export const runHealthSmokeProbe = (deps: SmokeProbeDeps, image: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const name = `provider-lando-smoke-health-${randomUUID()}`;
      yield* acquireSmokeContainer(deps, {
        operation: "health",
        name,
        body: {
          Image: image,
          Cmd: ["sh", "-c", "sleep 60"],
          Healthcheck: {
            Test: ["CMD-SHELL", "exit 0"],
            Interval: 100_000_000,
            Timeout: 1_000_000_000,
            Retries: 1,
          },
        },
      });
      yield* startSmokeContainer(deps, "health", name);
      yield* smokeApiRequest(deps, "health", {
        method: "GET",
        path: `/libpod/containers/${encodeURIComponent(name)}/healthcheck`,
      }).pipe(
        Effect.flatMap((response) =>
          expectSmokeSuccess("health", response, "Podman could not run the health smoke container check."),
        ),
      );
      let lastHealth = "invalid";
      const result = yield* runProbe(
        {
          id: "provider-lando-smoke-health",
          policy: deps.retryPolicy ?? defaultSmokeRetryPolicy,
          classify: {
            success: (value) => {
              lastHealth = typeof value === "string" ? value : "invalid";
              if (lastHealth === "healthy") return "green";
              if (lastHealth === "starting") return "yellow";
              return "red";
            },
            failure: () => "red",
          },
        },
        smokeApiRequest(deps, "health", {
          method: "GET",
          path: `/containers/${encodeURIComponent(name)}/json`,
        }).pipe(
          Effect.flatMap((response) =>
            expectSmokeSuccess("health", response, "Podman could not inspect the health smoke container."),
          ),
          Effect.map((response) => parseSmokeHealth(response.body)),
        ),
      ).pipe(mapFailures(mapProbeError("health")));
      if (result.outcome === "green") return;
      return yield* Effect.fail(failureFromResult("health", result, { lastHealth }));
    }),
  );

// Each `deploy.resources` field maps to one cgroup file inside the container; a mismatch exits
// with the code of the first file that does not hold the requested value.
const RESOURCE_LIMIT_EXPECTATIONS = [
  { file: "memory.max", value: "134217728", exitCode: 11 },
  { file: "pids.max", value: "100", exitCode: 12 },
  { file: "cpu.max", value: "50000 100000", exitCode: 13 },
  { file: "memory.low", value: "67108864", exitCode: 14 },
] as const;

const resourceLimitScript = RESOURCE_LIMIT_EXPECTATIONS.map(
  ({ file, value, exitCode }) => `[ "$(cat /sys/fs/cgroup/${file})" = "${value}" ] || exit ${exitCode}`,
).join("; ");

/** Limits, reservation and CPU quota requested at create must be what the container's cgroup enforces. */
export const runResourceLimitSmokeProbe = (deps: SmokeProbeDeps, image: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const name = `provider-lando-smoke-resources-${randomUUID()}`;
      yield* acquireSmokeContainer(deps, {
        operation: "resource-limits",
        name,
        body: {
          Image: image,
          Cmd: ["sh", "-c", resourceLimitScript],
          HostConfig: {
            Memory: 134_217_728,
            MemoryReservation: 67_108_864,
            PidsLimit: 100,
            NanoCpus: 500_000_000,
          },
        },
      });
      yield* startSmokeContainer(deps, "resource-limits", name);
      const response = yield* smokeApiRequest(deps, "resource-limits", {
        method: "POST",
        path: `/containers/${encodeURIComponent(name)}/wait`,
      }).pipe(
        Effect.flatMap((value) =>
          expectSmokeSuccess(
            "resource-limits",
            value,
            "Podman could not wait for the resource-limit smoke container.",
          ),
        ),
      );
      const exitCode = parseSmokeExitCode(response.body);
      if (exitCode === 0) return;
      const mismatch = RESOURCE_LIMIT_EXPECTATIONS.find((expectation) => expectation.exitCode === exitCode);
      return yield* Effect.fail(
        new ProviderLandoSmokeError({
          smokeOperation: "resource-limits",
          message:
            mismatch === undefined
              ? `The resource-limit smoke container exited with code ${String(exitCode ?? "unknown")}.`
              : `The container's /sys/fs/cgroup/${mismatch.file} does not hold the requested ${mismatch.value}.`,
          remediation: smokeRemediation("resource-limits"),
          details: {
            ...(exitCode === undefined ? {} : { exitCode }),
            ...(mismatch === undefined ? {} : { file: mismatch.file, expected: mismatch.value }),
          },
        }),
      );
    }),
  );

export const runSmokeReadinessProbe = Effect.fn("ProviderLando.runSmokeReadinessProbe")(function* (
  deps: SmokeProbeDeps,
): Effect.fn.Return<void, ProviderLandoSmokeError, Scope.Scope> {
  const baseImage = deps.baseImage ?? DEFAULT_BASE_IMAGE;
  yield* ensureSmokeBaseImage(deps, baseImage);
  yield* runContainerSmokeProbe(deps, baseImage);
  yield* runBuildSmokeProbe(deps, baseImage);
  yield* runHealthSmokeProbe(deps, baseImage);
  if (deps.resourceLimits === true) yield* runResourceLimitSmokeProbe(deps, baseImage);
});

export { DEFAULT_BASE_IMAGE, ProviderLandoSmokeError } from "./smoke-probe-support.ts";
export type { SmokeOperation, SmokeProbeDeps } from "./smoke-probe-support.ts";
