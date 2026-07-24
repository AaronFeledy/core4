import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, ServiceName, type ServicePlan } from "@lando/sdk/schema";

import {
  PHP_APT_PACKAGE_PINS,
  PHP_COMMON_EXTENSIONS,
  PHP_COMPOSER,
  PHP_COMPOSER_COMMAND,
  PHP_FEATURE_ID,
  PHP_PREREQUISITES_COMMAND,
  php82ServiceType,
  phpServiceFeature,
} from "../src/services/php.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const BuildSteps = Schema.Struct({
  buildSteps: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.optional(Schema.String),
        command: Schema.Unknown,
        buildKeyInputs: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
      }),
    ),
  ),
});

const composePhpPlan = (image?: string): Promise<ServicePlan> => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "php-prerequisites",
    services: { web: { type: "php:8.2", ...(image === undefined ? {} : { image }) } },
  });
  const service = landofile.services?.[ServiceName.make("web")];
  if (service === undefined) throw new Error("web service missing");
  return composeServicePlan({
    serviceType: php82ServiceType,
    service,
    appRoot: "/srv/apps/php-prerequisites",
    appName: "php-prerequisites",
    serviceName: "web",
    metadata: {
      resolvedAt: "2026-07-23T00:00:00Z",
      source: "/srv/apps/php-prerequisites/.lando.yml",
      runtime: 4,
    },
    featureOverrides: new Map([[PHP_FEATURE_ID, phpServiceFeature]]),
  });
};

const buildStepsFor = (plan: ServicePlan) =>
  Schema.decodeUnknownSync(BuildSteps)(plan.extensions["@lando/core/service-features"]).buildSteps ?? [];

describe("stock PHP prerequisite plan", () => {
  test("carries exact executable and build-key identities", async () => {
    const steps = buildStepsFor(await composePhpPlan());

    expect(steps.map(({ id }) => id)).toEqual([
      "service-lando.php:prerequisites",
      "service-lando.php:composer",
    ]);
    expect(steps[0]?.buildKeyInputs).toEqual({
      aptPackages: PHP_APT_PACKAGE_PINS,
      extensions: PHP_COMMON_EXTENSIONS,
    });
    expect(steps[0]?.command).toBe(PHP_PREREQUISITES_COMMAND);
    expect(steps[1]?.buildKeyInputs).toEqual({ composer: PHP_COMPOSER });
    expect(steps[1]?.command).toBe(PHP_COMPOSER_COMMAND);
  });

  test("treats a custom image as the prerequisite opt-out", async () => {
    const plan = await composePhpPlan("registry.example.com/php:8.2-custom");

    expect(plan.artifact).toEqual({ kind: "ref", ref: "registry.example.com/php:8.2-custom" });
    expect(buildStepsFor(plan)).toEqual([]);
  });
});
