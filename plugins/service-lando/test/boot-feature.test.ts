import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { ProviderId, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import type { ServiceFeatureDefinition } from "@lando/sdk/services";

import { composeService } from "@lando/engine/services/feature";
import { serviceFeatures } from "../src/features/index.ts";
import { landoServiceType } from "../src/services/lando.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const FeatureExtension = Schema.Struct({
  buildSteps: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.optional(Schema.String),
        phase: Schema.String,
        command: Schema.Unknown,
        user: Schema.optional(Schema.String),
      }),
    ),
  ),
});

const bootFeature = (): ServiceFeatureDefinition => {
  const definition = serviceFeatures.get("lando.boot");
  expect(definition).toBeDefined();
  if (definition === undefined) throw new Error("lando.boot feature missing");
  return definition;
};

const composeBootPlan = (): Promise<ServicePlan> =>
  Effect.runPromise(
    composeService({
      base: {
        name: ServiceName.make("web"),
        type: "node:22",
        provider: ProviderId.make("lando"),
        primary: true,
        defaultFeatures: [],
      },
      baseKind: "lando",
      appName: "boot-test",
      appRoot: "/srv/apps/boot-test",
      normalizedConfig: { type: "node:22" },
      features: [{ id: "lando.boot", definition: bootFeature() }],
    }),
  );

const buildStepsFor = (plan: ServicePlan) =>
  Schema.decodeUnknownSync(FeatureExtension)(plan.extensions["@lando/core/service-features"]).buildSteps ??
  [];

describe("lando.boot feature", () => {
  test("the default lando stack adds no executable steps for a custom image", async () => {
    // Given
    const service = { type: "lando", image: "traefik/whoami", home: false as const };
    // When
    const plan = await composeServicePlan({
      serviceType: landoServiceType,
      service,
      appRoot: "/srv/apps/boot-test",
      metadata: { resolvedAt: "2026-09-23T00:00:00Z", source: "boot-feature.test.ts", runtime: 4 },
    });
    // Then
    expect(buildStepsFor(plan)).toEqual([
      {
        id: "lando.boot:scaffold",
        phase: "build",
        command: { directories: ["/etc/lando", "/etc/lando/env.d", "/etc/lando/certs"] },
      },
    ]);
    expect(plan.artifact).toEqual({ kind: "ref", ref: "traefik/whoami" });
    expect(plan.command).toBeUndefined();
    expect(plan.entrypoint).toBeUndefined();
    expect(plan.user).toBeUndefined();
    expect(plan.environment.LANDO).toBe("ON");
  });

  test("scaffolds directories without executing a command in the image", async () => {
    // Given / When: compose the boot feature for an image with no assumed executables.
    const plan = await composeBootPlan();
    const steps = buildStepsFor(plan);
    const rawSteps =
      (plan.extensions["@lando/core/service-features"] as { buildSteps?: ReadonlyArray<object> } | undefined)
        ?.buildSteps ?? [];

    // Then: directory creation is filesystem intent, not a shell or executable command.
    expect(steps).toEqual([
      {
        id: "lando.boot:scaffold",
        phase: "build",
        command: { directories: ["/etc/lando", "/etc/lando/env.d", "/etc/lando/certs"] },
      },
    ]);
    expect("privileged" in (rawSteps[0] ?? {})).toBe(false);
    expect(plan.mounts).toEqual([]);
    expect(plan.environment).toEqual({});
  });
});
