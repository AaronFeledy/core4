import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, type ServiceConfig, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import type { ServiceType } from "@lando/sdk/services";

import {
  NODE_FEATURE_ID,
  NODE_GLOBALS_STEP_ID,
  node22ServiceType,
  nodeServiceFeature,
} from "../src/services/node.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const BuildSteps = Schema.Struct({
  buildSteps: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.optional(Schema.String),
        phase: Schema.optional(Schema.String),
        command: Schema.Unknown,
        user: Schema.optional(Schema.String),
        buildKeyInputs: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
      }),
    ),
  ),
});

const decodeService = (raw: unknown): ServiceConfig => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "node-globals",
    services: { web: raw },
  });
  const service = landofile.services?.[ServiceName.make("web")];
  if (service === undefined) throw new Error("web service missing");
  return service;
};

const composeNodePlan = (
  raw: Record<string, unknown>,
  serviceType: ServiceType = node22ServiceType,
): Promise<ServicePlan> =>
  composeServicePlan({
    serviceType,
    service: decodeService({ type: serviceType.id, ...raw }),
    appRoot: "/srv/apps/node-globals",
    appName: "node-globals",
    serviceName: "web",
    metadata: {
      resolvedAt: "2026-09-13T00:00:00Z",
      source: "/srv/apps/node-globals/.lando.yml",
      runtime: 4,
    },
    featureOverrides: new Map([[NODE_FEATURE_ID, nodeServiceFeature]]),
    applyAuthoredWrappers: false,
  });

const buildStepsFor = (plan: ServicePlan) =>
  Schema.decodeUnknownSync(BuildSteps)(plan.extensions["@lando/core/service-features"]).buildSteps ?? [];

const expectRejectsToThrow = async (promise: Promise<unknown>, pattern: RegExp): Promise<void> => {
  let rejected = false;
  await promise.then(
    () => undefined,
    (error: unknown) => {
      rejected = true;
      expect(error instanceof Error ? error.message : String(error)).toMatch(pattern);
    },
  );
  expect(rejected).toBe(true);
};

describe("node globals build step", () => {
  test("plans one sorted npm global install step", async () => {
    // Given a node service authoring two global packages,
    // when the plan is composed,
    // then a single root-owned build step installs them in sorted order and
    // carries the normalized list as its build-key identity.
    const plan = await composeNodePlan({ globals: { yarn: "1.22.4", "gulp-cli": "latest" } });
    const step = buildStepsFor(plan).find((candidate) => candidate.id === NODE_GLOBALS_STEP_ID);

    expect(step).toBeDefined();
    expect(step?.phase).toBe("build");
    expect(step?.user).toBe("root");
    expect(step?.command).toBe(
      "set -eux && npm install -g --force --no-fund --no-audit 'gulp-cli@latest' 'yarn@1.22.4'",
    );
    expect(step?.buildKeyInputs).toEqual({
      globals: [
        ["gulp-cli", "latest"],
        ["yarn", "1.22.4"],
      ],
    });
  });

  test("normalizes authored package order into one stable step", async () => {
    // Given the same globals authored in reversed order,
    // when both plans are composed,
    // then the emitted build steps are deep equal, so the artifact identity
    // cannot change with authoring order.
    const forward = await composeNodePlan({ globals: { "gulp-cli": "latest", yarn: "1.22.4" } });
    const reversed = await composeNodePlan({ globals: { yarn: "1.22.4", "gulp-cli": "latest" } });

    expect(buildStepsFor(reversed)).toEqual(buildStepsFor(forward));
  });

  test("emits no step when globals is absent or empty", async () => {
    // Given a node service with no globals, or an empty map,
    // when the plan is composed,
    // then no globals build step is emitted.
    for (const raw of [{}, { globals: {} }]) {
      const steps = buildStepsFor(await composeNodePlan(raw));
      expect(steps.some((step) => step.id === NODE_GLOBALS_STEP_ID)).toBe(false);
    }
  });

  test("installs globals into a custom image instead of dropping authored intent", async () => {
    // Given a node service that brings its own image,
    // when the plan is composed,
    // then the authored globals are still installed.
    const plan = await composeNodePlan({
      image: "node:22-alpine",
      globals: { yarn: "1.22.4" },
    });

    expect(buildStepsFor(plan).some((step) => step.id === NODE_GLOBALS_STEP_ID)).toBe(true);
  });

  test("rejects an invalid npm package name with remediation", async () => {
    await expectRejectsToThrow(
      composeNodePlan({ globals: { "../escape": "1.0.0" } }),
      /Unsupported npm package "\.\.\/escape"/,
    );
  });

  test("rejects a secret reference in a global version", async () => {
    await expectRejectsToThrow(
      composeNodePlan({ globals: { yarn: "${secret:NPM_TOKEN}" } }),
      /Unsupported npm version specifier .* for "yarn"/,
    );
  });
});
