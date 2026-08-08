import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { ProviderId, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import type { ServiceFeatureDefinition } from "@lando/sdk/services";

import { composeService } from "@lando/engine/services/feature";
import { serviceFeatures } from "../src/features/index.ts";

const FeatureExtension = Schema.Struct({
  buildSteps: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.optional(Schema.String),
        phase: Schema.String,
        command: Schema.Unknown,
        privileged: Schema.optional(Schema.Boolean),
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
  test("emits only the idempotent artifact scaffold step", async () => {
    const plan = await composeBootPlan();

    expect(buildStepsFor(plan)).toEqual([
      {
        id: "lando.boot:scaffold",
        phase: "build",
        command: "mkdir -p /etc/lando /etc/lando/env.d /etc/lando/certs",
        privileged: true,
      },
    ]);
    expect(plan.mounts).toEqual([]);
    expect(plan.environment).toEqual({});
  });
});
