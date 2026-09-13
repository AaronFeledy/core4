import { describe, expect, test } from "bun:test";
import { DateTime, Effect } from "effect";

import { ProviderId, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { appBuildKeyForStep, buildKeyForService } from "../../src/services/build-key.ts";

const providerId = ProviderId.make("test");
const provider = { ...TestRuntimeProvider, id: providerId, version: "1.0.0", platform: "linux" as const };

const baseServiceFields = {
  name: ServiceName.make("web"),
  type: "node",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref" as const, ref: "debian:12" },
  environment: {},
  mounts: [] as ServicePlan["mounts"],
  storage: [] as ServicePlan["storage"],
  endpoints: [] as ServicePlan["endpoints"],
  routes: [] as ServicePlan["routes"],
  dependsOn: [] as ServicePlan["dependsOn"],
  hostAliases: [] as ServicePlan["hostAliases"],
  metadata: {
    resolvedAt: DateTime.unsafeMake("2026-08-01T00:00:00.000Z"),
    source: "build-key-user.test",
    runtime: 4 as const,
  },
};

const serviceWithStepUser = (user?: string | null): ServicePlan => ({
  ...baseServiceFields,
  extensions: {
    "@lando/core/service-features": {
      buildSteps: [
        {
          id: "scaffold",
          phase: "build",
          command: "mkdir -p /etc/lando",
          ...(user === null ? { user: undefined } : user === undefined ? {} : { user }),
        },
      ],
    },
  },
});

const serviceWithOrderedSteps = (steps: ReadonlyArray<{ readonly user?: string }>): ServicePlan => ({
  ...baseServiceFields,
  extensions: {
    "@lando/core/service-features": {
      buildSteps: steps.map((step, index) => ({
        id: `step-${index}`,
        phase: "build" as const,
        command: "true",
        ...(step.user === undefined ? {} : { user: step.user }),
      })),
    },
  },
});

const keyForStepUser = (user?: string | null): Promise<string> =>
  Effect.runPromise(buildKeyForService(provider, serviceWithStepUser(user)));

const keyForOrderedSteps = (steps: ReadonlyArray<{ readonly user?: string }>): Promise<string> =>
  Effect.runPromise(buildKeyForService(provider, serviceWithOrderedSteps(steps)));

describe("build step user identity", () => {
  test("changes the artifact build key when step user differs", async () => {
    // Given / When
    const asRoot = await keyForStepUser("root");
    const asWww = await keyForStepUser("www-data");

    // Then
    expect(asRoot).not.toBe(asWww);
  });

  test("keeps repeated identical user inputs stable", async () => {
    // Given / When
    const first = await keyForStepUser("root");
    const repeated = await keyForStepUser("root");

    // Then
    expect(repeated).toBe(first);
  });

  test("treats omitted user the same as an explicitly-absent user key", async () => {
    // Given / When
    const omitted = await keyForStepUser(undefined);
    const explicitAbsent = await keyForStepUser(null);

    // Then
    expect(omitted).toBe(explicitAbsent);
  });

  test("keeps step order significant when the same user is on different steps", async () => {
    // Given / When
    const userFirst = await keyForOrderedSteps([{ user: "root" }, {}]);
    const userSecond = await keyForOrderedSteps([{}, { user: "root" }]);

    // Then
    expect(userFirst).not.toBe(userSecond);
  });
});

describe("appBuildKeyForStep user identity", () => {
  const appService = (): ServicePlan => ({
    ...baseServiceFields,
    extensions: {},
  });

  test("changes the app-phase key when the step resolved user changes", () => {
    // Given
    const service = appService();
    const base = {
      command: ["sh", "-c", "echo hi"],
      service,
      stepId: "app-step",
    };

    // When
    const asRoot = appBuildKeyForStep({ ...base, user: "root" });
    const asWww = appBuildKeyForStep({ ...base, user: "www-data" });
    const omitted = appBuildKeyForStep(base);
    const repeated = appBuildKeyForStep({ ...base, user: "root" });

    // Then
    expect(asRoot).not.toBe(asWww);
    expect(asRoot).not.toBe(omitted);
    expect(repeated).toBe(asRoot);
  });
});
