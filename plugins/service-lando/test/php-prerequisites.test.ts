import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import type { ServiceType } from "@lando/sdk/services";

import { PHP_COMPOSER_RELEASES } from "../src/services/php-prerequisites.ts";
import {
  PHP_APT_PACKAGE_PINS,
  PHP_COMMON_EXTENSIONS,
  PHP_COMPOSER,
  PHP_COMPOSER_COMMAND,
  PHP_FEATURE_ID,
  PHP_PREREQUISITES_COMMAND,
  php82ServiceType,
  php84ServiceType,
  php85ServiceType,
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

const composePhpPlan = (
  overrides: Record<string, unknown> = {},
  serviceType: ServiceType = php82ServiceType,
): Promise<ServicePlan> => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "php-prerequisites",
    services: { web: { type: serviceType.id, ...overrides } },
  });
  const service = landofile.services?.[ServiceName.make("web")];
  if (service === undefined) throw new Error("web service missing");
  return composeServicePlan({
    serviceType,
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

const expectRejectsToThrow = async (promise: Promise<unknown>, pattern: RegExp): Promise<void> => {
  let rejected = false;
  await promise.then(
    () => undefined,
    (error: unknown) => {
      rejected = true;
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toMatch(pattern);
    },
  );
  expect(rejected).toBe(true);
};

describe("stock PHP prerequisite plan", () => {
  test("carries exact executable and build-key identities", async () => {
    const steps = buildStepsFor(await composePhpPlan());

    expect(steps.map(({ id }) => id)).toEqual([
      "lando.boot:scaffold",
      "service-lando.php:prerequisites",
      "service-lando.php:composer",
    ]);
    expect(steps[1]?.buildKeyInputs).toEqual({
      aptPackages: PHP_APT_PACKAGE_PINS,
      extensions: PHP_COMMON_EXTENSIONS,
    });
    expect(steps[1]?.command).toBe(PHP_PREREQUISITES_COMMAND);
    expect(steps[2]?.buildKeyInputs).toEqual({ composer: PHP_COMPOSER });
    expect(steps[2]?.command).toBe(PHP_COMPOSER_COMMAND);
  });

  test("treats a custom image as the prerequisite opt-out", async () => {
    const plan = await composePhpPlan({ image: "registry.example.com/php:8.2-custom" });

    expect(plan.artifact).toEqual({ kind: "ref", ref: "registry.example.com/php:8.2-custom" });
    expect(buildStepsFor(plan).map(({ id }) => id)).toEqual(["lando.boot:scaffold"]);
  });

  test("omits the Composer build step when composer is false", async () => {
    const steps = buildStepsFor(await composePhpPlan({ composer: false }));

    expect(steps.map(({ id }) => id)).toEqual(["lando.boot:scaffold", "service-lando.php:prerequisites"]);
  });

  test("installs an exact Composer release into build-key identity", async () => {
    const steps = buildStepsFor(await composePhpPlan({ composer: "2.7.7" }));
    const composerStep = steps.find((step) => step.id === "service-lando.php:composer");
    const release = PHP_COMPOSER_RELEASES["2.7.7"];

    expect(composerStep?.buildKeyInputs).toEqual({ composer: release });
    expect(String(composerStep?.command)).toContain(release.url);
    expect(String(composerStep?.command)).toContain(release.sha256);
    expect(composerStep?.buildKeyInputs).not.toEqual({ composer: PHP_COMPOSER });
  });

  test("maps composer major 2 to the pinned bundled release", async () => {
    const steps = buildStepsFor(await composePhpPlan({ composer: "2" }));
    const composerStep = steps.find((step) => step.id === "service-lando.php:composer");

    expect(composerStep?.buildKeyInputs).toEqual({ composer: PHP_COMPOSER });
  });

  test("rejects an unknown Composer version with remediation", async () => {
    const planned = composePhpPlan({ composer: "nope" });
    await expectRejectsToThrow(planned, /Unsupported Composer version "nope"/);
    await expectRejectsToThrow(planned, /composer: "2"/);
    await expectRejectsToThrow(planned, /composer: false/);
  });

  test("rejects an unknown Composer version when a custom image skips install", async () => {
    const planned = composePhpPlan({ image: "registry.example.com/php:8.2-custom", composer: "nope" });
    await expectRejectsToThrow(planned, /Unsupported Composer version "nope"/);
    await expectRejectsToThrow(planned, /composer: "2"/);
    await expectRejectsToThrow(planned, /composer: false/);
  });
});

describe("PHP Composer compatibility", () => {
  test("rejects composer 2.7.7 when planning php:8.5", async () => {
    await expectRejectsToThrow(
      composePhpPlan({ composer: "2.7.7" }, php85ServiceType),
      /cannot run on PHP 8\.5/,
    );
    await expectRejectsToThrow(composePhpPlan({ composer: "2.7.7" }, php85ServiceType), /composer: "2"/);
    await expectRejectsToThrow(composePhpPlan({ composer: "2.7.7" }, php85ServiceType), /2\.10\.2/);
  });

  test("plans composer major 2 when php is 8.5", async () => {
    const steps = buildStepsFor(await composePhpPlan({ composer: "2" }, php85ServiceType));
    const composerStep = steps.find((step) => step.id === "service-lando.php:composer");

    expect(composerStep?.buildKeyInputs).toEqual({ composer: PHP_COMPOSER });
  });

  test("keeps authored composer 2.10.2 pin when php is 8.5", async () => {
    const steps = buildStepsFor(await composePhpPlan({ composer: "2.10.2" }, php85ServiceType));
    const composerStep = steps.find((step) => step.id === "service-lando.php:composer");

    expect(composerStep?.buildKeyInputs?.composer).toMatchObject({ version: "2.10.2" });
  });

  test("omits composer build step when php:8.5 sets composer false", async () => {
    const steps = buildStepsFor(await composePhpPlan({ composer: false }, php85ServiceType));

    expect(steps.map(({ id }) => id)).toEqual(["lando.boot:scaffold", "service-lando.php:prerequisites"]);
  });

  test("plans composer 2.7.7 when php is 8.4", async () => {
    const steps = buildStepsFor(await composePhpPlan({ composer: "2.7.7" }, php84ServiceType));
    const composerStep = steps.find((step) => step.id === "service-lando.php:composer");

    expect(composerStep?.buildKeyInputs).toEqual({ composer: PHP_COMPOSER_RELEASES["2.7.7"] });
  });
});
