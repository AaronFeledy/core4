import { randomUUID } from "node:crypto";

import { Effect, type Scope } from "effect";

import { type ProbeResult, runProbe } from "@lando/sdk/probe";

import { redactDetails } from "./redact.ts";
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

const failureFromResult = (
  operation: "run" | "build" | "health",
  result: ProbeResult,
  details: Readonly<Record<string, unknown>> = {},
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
      ...(result.lastError === undefined ? {} : { lastError: redactDetails(result.lastError) }),
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
        details: cause,
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
          body: { Image: image, Cmd: ["sh", "-c", "exit 0"] },
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
            details: { exitCode },
          }),
        );
      }),
    ),
  ).pipe(
    Effect.mapError(mapProbeError("run")),
    Effect.flatMap((result) => requireGreen("run", result)),
  );

export const runBuildSmokeProbe = (deps: SmokeProbeDeps, baseImage: string) => {
  const image = `provider-lando-smoke-build:${randomUUID()}`;
  const cleanup = removeSmokeResource(deps, "build", `/images/${encodeURIComponent(image)}?force=true`);
  const buildParams = new URLSearchParams({ t: image, dockerfile: "Dockerfile" });
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
    Effect.mapError(mapProbeError("build")),
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
      ).pipe(Effect.mapError(mapProbeError("health")));
      if (result.outcome === "green") return;
      return yield* Effect.fail(failureFromResult("health", result, { lastHealth }));
    }),
  );

export const runSmokeReadinessProbe = (
  deps: SmokeProbeDeps,
): Effect.Effect<void, ProviderLandoSmokeError, Scope.Scope> =>
  Effect.gen(function* () {
    const baseImage = deps.baseImage ?? DEFAULT_BASE_IMAGE;
    yield* ensureSmokeBaseImage(deps, baseImage);
    yield* runContainerSmokeProbe(deps, baseImage);
    yield* runBuildSmokeProbe(deps, baseImage);
    yield* runHealthSmokeProbe(deps, baseImage);
  });

export { DEFAULT_BASE_IMAGE, ProviderLandoSmokeError } from "./smoke-probe-support.ts";
export type { SmokeOperation, SmokeProbeDeps } from "./smoke-probe-support.ts";
