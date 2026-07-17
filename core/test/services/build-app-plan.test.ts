import { describe, expect, test } from "bun:test";

import { DateTime } from "effect";

import { AbsolutePath, AppId, type AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import { appStepBatches, appSteps } from "../../src/services/build-app-plan.ts";

const planWithSteps = (buildSteps: ReadonlyArray<unknown>): AppPlan => {
  const provider = ProviderId.make("test");
  const name = ServiceName.make("web");
  return {
    id: AppId.make("app-build-plan"),
    name: "App build plan",
    slug: "app-build-plan",
    root: AbsolutePath.make("/tmp/app-build-plan"),
    provider,
    services: {
      [name]: {
        name,
        type: "node",
        provider,
        primary: true,
        artifact: { kind: "ref", ref: "node:22", digest: "sha256:first" },
        environment: {},
        mounts: [],
        storage: [],
        endpoints: [],
        routes: [],
        dependsOn: [],
        hostAliases: [],
        metadata: {
          resolvedAt: DateTime.unsafeMake("2026-07-17T00:00:00Z"),
          source: "build-app-plan.test",
          runtime: 4,
        },
        extensions: { "@lando/core/service-features": { buildSteps } },
      },
    },
    routes: [],
    networks: [],
    stores: [],
    fileSync: [],
    metadata: {
      resolvedAt: DateTime.unsafeMake("2026-07-17T00:00:00Z"),
      source: "build-app-plan.test",
      runtime: 4,
    },
    extensions: {},
  };
};

describe("appSteps", () => {
  test("orders authored steps for the same service after explicit dependencies", () => {
    // Given
    const plan = planWithSteps([
      { id: "prepare", phase: "app", command: { command: ["prepare"] }, dependsOn: ["db:running"] },
      { id: "install", phase: "app", command: { command: ["install"] } },
    ]);

    // When
    const steps = appSteps(plan).map(({ step }) => step);

    // Then
    expect(steps.map((step) => [step.id, step.dependsOn])).toEqual([
      ["web:app:prepare", ["db:running"]],
      ["web:app:install", ["web:app:prepare"]],
    ]);
  });

  test("gives repeated commands at distinct authored positions distinct cache identities", () => {
    // Given
    const plan = planWithSteps([
      { id: "first", phase: "app", command: { command: ["npm", "install"] } },
      { id: "second", phase: "app", command: { command: ["npm", "install"] } },
    ]);

    // When
    const steps = appSteps(plan).map(({ step }) => step);

    // Then
    expect(steps[0]?.buildKey).not.toBe(steps[1]?.buildKey);
  });

  test("resolves authored dependency ids to service-scoped step ids", () => {
    // Given
    const plan = planWithSteps([
      { id: "setup", phase: "app", command: { command: ["setup"] } },
      { id: "prepare", phase: "app", command: { command: ["prepare"] } },
      {
        id: "install",
        phase: "app",
        command: { command: ["install"] },
        dependsOn: ["setup", "db:running"],
      },
    ]);

    // When
    const install = appSteps(plan)[2]?.step;

    // Then
    expect(install?.dependsOn).toEqual(["web:app:setup", "db:running", "web:app:prepare"]);
  });

  test("invalidates app cache identity when the built artifact changes", () => {
    // Given
    const first = planWithSteps([{ id: "install", phase: "app", command: { command: ["install"] } }]);
    const service = first.services[ServiceName.make("web")];
    if (service === undefined) throw new TypeError("web service fixture is missing");
    const rebuilt: AppPlan = {
      ...first,
      services: {
        ...first.services,
        [service.name]: { ...service, artifact: { kind: "ref", ref: "node:22", digest: "sha256:second" } },
      },
    };

    // When
    const firstKey = appSteps(first)[0]?.step.buildKey;
    const rebuiltKey = appSteps(rebuilt)[0]?.step.buildKey;

    // Then
    expect(rebuiltKey).not.toBe(firstKey);
  });

  test("returns typed cycle data instead of throwing", () => {
    // Given
    const plan = planWithSteps([
      {
        id: "prepare",
        phase: "app",
        command: { command: ["prepare"] },
        dependsOn: ["install"],
      },
      { id: "install", phase: "app", command: { command: ["install"] } },
    ]);

    // When
    const result = appStepBatches(appSteps(plan));

    // Then
    expect(result).toEqual({
      _tag: "Cycle",
      edges: ["web:app:prepare -> web:app:install", "web:app:install -> web:app:prepare"],
    });
  });
});
