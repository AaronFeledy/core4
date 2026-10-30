import { expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { LandofileShape, ServiceName } from "@lando/sdk/schema";
import { AppPlanner } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Result, Schema } from "effect";
import * as AppPlanCache from "../../src/cache/app-plan.ts";
import * as AppCacheService from "../../src/cache/service.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import * as AppPlannerLayer from "../../src/services/planner.ts";
import { literalTestLandofile } from "../compiled-landofile.ts";

test("readiness changes invalidate an otherwise identical app-plan fingerprint", () => {
  // Given
  const key = (readiness?: false) =>
    AppPlanCache.deriveAppPlanCacheKey({
      hostProvider: "test",
      appRoot: "/app",
      pluginManifests: [],
      landofile: Schema.decodeUnknownSync(LandofileShape)({
        services: {
          web: {
            type: "python:3.12",
            healthcheck: ["native"],
            ...(readiness === undefined ? {} : { readiness }),
          },
        },
      }),
    });
  // When / Then
  expect(key(false)).not.toBe(key());
});

const runPlan = (healthcheck?: unknown) =>
  Effect.flatMap(AppPlanner, (planner) =>
    planner.plan(
      literalTestLandofile(
        Schema.decodeUnknownSync(LandofileShape)({
          name: "healthcheck-cache",
          runtime: 4,
          services: {
            web: { type: "python:3.12", home: false, ...(healthcheck === undefined ? {} : { healthcheck }) },
          },
        }),
        tmpdir(),
      ),
      TestRuntimeProvider.capabilities,
    ),
  ).pipe(
    Effect.provide(AppPlannerLayer.layer),
    Effect.provide(AppCacheService.layer),
    Effect.provide(PluginRegistryLayer.layer),
  );

test.each([{ target: "host" }, { target: "host", command: "true", user: "root" }])(
  "fresh planning rejects unsupported host execution",
  async (healthcheck) => {
    // Given / When
    const result = await Effect.runPromise(Effect.result(runPlan(healthcheck)));
    // Then
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure._tag).toBe("HealthcheckTargetUnsupportedError");
  },
);

test("a matching cached plan cannot bypass execution validation", async () => {
  // Given
  const original = await Effect.runPromise(runPlan());
  const name = ServiceName.make("web");
  const web = original.services[name];
  if (web === undefined) throw new TypeError("Missing planned service");
  const cached = {
    ...original,
    services: {
      [name]: {
        ...web,
        readiness: {
          kind: "command" as const,
          command: ["ready"],
          executionTarget: "host" as const,
          user: "root",
          intervalSeconds: 0,
          timeoutSeconds: 1,
          retries: 1,
        },
      },
    },
  };
  const lookup = spyOn(AppPlanCache, "readCachedAppPlan").mockReturnValue(Effect.succeed(cached));
  try {
    // When
    const result = await Effect.runPromise(Effect.result(runPlan()));
    // Then
    expect(lookup).toHaveBeenCalled();
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure._tag).toBe("HealthcheckTargetUnsupportedError");
  } finally {
    lookup.mockRestore();
  }
});
