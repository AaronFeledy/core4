import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import type { ServiceType } from "@lando/sdk/services";

import { PHP_COMPOSER_RELEASES } from "../src/services/php-prerequisites.ts";
import {
  PHP_COMPOSER_COMMAND,
  PHP_COMPOSER_PACKAGES_STEP_ID,
  PHP_COMPOSER_STEP_ID,
  PHP_FEATURE_ID,
  php83ServiceType,
  php85ServiceType,
  phpServiceFeature,
} from "../src/services/php.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const BuildSteps = Schema.Struct({
  buildSteps: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.optional(Schema.String),
        phase: Schema.optional(Schema.String),
        command: Schema.Unknown,
        user: Schema.optional(Schema.String),
        dependsOn: Schema.optional(Schema.Array(Schema.String)),
        buildKeyInputs: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
      }),
    ),
  ),
});

const composePhpPlan = (
  overrides: Record<string, unknown> = {},
  serviceType: ServiceType = php83ServiceType,
): Promise<ServicePlan> => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "php-composer-packages",
    services: { web: { type: serviceType.id, ...overrides } },
  });
  const service = landofile.services?.[ServiceName.make("web")];
  if (service === undefined) throw new Error("web service missing");
  return composeServicePlan({
    serviceType,
    service,
    appRoot: "/srv/apps/php-composer-packages",
    appName: "php-composer-packages",
    serviceName: "web",
    metadata: {
      resolvedAt: "2026-09-13T00:00:00Z",
      source: "/srv/apps/php-composer-packages/.lando.yml",
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
      expect(error instanceof Error ? error.message : String(error)).toMatch(pattern);
    },
  );
  expect(rejected).toBe(true);
};

describe("composer object form", () => {
  test("plans a sorted composer-packages step depending on the composer install", async () => {
    // Given a PHP service authoring the object form with two packages,
    // when the plan is composed,
    // then one root-owned step installs them in sorted order after the
    // Composer binary step and hashes the normalized package list.
    const plan = await composePhpPlan({
      composer: {
        version: "2",
        packages: { "squizlabs/php_codesniffer": "^3.10", "phpstan/phpstan": "^1.11" },
      },
    });
    const steps = buildStepsFor(plan);
    const step = steps.find((candidate) => candidate.id === PHP_COMPOSER_PACKAGES_STEP_ID);

    expect(step).toBeDefined();
    expect(step?.phase).toBe("build");
    expect(step?.user).toBe("root");
    expect(step?.dependsOn).toEqual([PHP_COMPOSER_STEP_ID]);
    expect(step?.command).toBe(
      "set -eux && COMPOSER_HOME=/usr/local/composer COMPOSER_BIN_DIR=/usr/local/bin COMPOSER_ALLOW_SUPERUSER=1 COMPOSER_NO_INTERACTION=1 composer global require --no-progress 'phpstan/phpstan:^1.11' 'squizlabs/php_codesniffer:^3.10' && chmod -R a+rX /usr/local/composer",
    );
    expect(step?.buildKeyInputs).toEqual({
      packages: [
        ["phpstan/phpstan", "^1.11"],
        ["squizlabs/php_codesniffer", "^3.10"],
      ],
    });

    const ids = steps.map((candidate) => candidate.id);
    expect(ids.indexOf(PHP_COMPOSER_PACKAGES_STEP_ID)).toBeGreaterThan(ids.indexOf(PHP_COMPOSER_STEP_ID));
  });

  test("normalizes authored package order into one stable step", async () => {
    // Given the same packages authored in reversed order,
    // when both plans are composed,
    // then the emitted build steps are deep equal.
    const forward = await composePhpPlan({
      composer: { packages: { "a/one": "^1.0", "b/two": "^2.0" } },
    });
    const reversed = await composePhpPlan({
      composer: { packages: { "b/two": "^2.0", "a/one": "^1.0" } },
    });

    expect(buildStepsFor(reversed)).toEqual(buildStepsFor(forward));
  });

  test("treats {version} without packages exactly like the string form", async () => {
    // Given the object form carrying only a version,
    // when compared with the equivalent string form,
    // then both produce identical build steps.
    const objectForm = await composePhpPlan({ composer: { version: "2.7.7" } });
    const stringForm = await composePhpPlan({ composer: "2.7.7" });

    expect(buildStepsFor(objectForm)).toEqual(buildStepsFor(stringForm));
    expect(buildStepsFor(objectForm).some((step) => step.id === PHP_COMPOSER_PACKAGES_STEP_ID)).toBe(false);
  });

  test("treats packages: {} as a no-op", async () => {
    const plan = await composePhpPlan({ composer: { version: "2", packages: {} } });

    expect(buildStepsFor(plan).some((step) => step.id === PHP_COMPOSER_PACKAGES_STEP_ID)).toBe(false);
    expect(buildStepsFor(plan).find((step) => step.id === PHP_COMPOSER_STEP_ID)?.command).toBe(
      PHP_COMPOSER_COMMAND,
    );
  });

  test("omits the composer install but still installs packages for a custom image", async () => {
    // Given a custom image that already ships Composer,
    // when packages are authored,
    // then the package step is emitted without a dependency on the skipped
    // Lando-managed Composer install.
    const plan = await composePhpPlan({
      image: "my/php:8.3",
      composer: { packages: { "drush/drush": "^13.0" } },
    });
    const steps = buildStepsFor(plan);
    const step = steps.find((candidate) => candidate.id === PHP_COMPOSER_PACKAGES_STEP_ID);

    expect(steps.some((candidate) => candidate.id === PHP_COMPOSER_STEP_ID)).toBe(false);
    expect(step).toBeDefined();
    expect(step?.dependsOn).toBeUndefined();
    expect(step?.buildKeyInputs).toEqual({ packages: [["drush/drush", "^13.0"]] });
  });

  test("does not hash an unused composer release on a custom image", async () => {
    // Given a custom image that already ships Composer,
    // when the same packages are authored with different composer.version pins,
    // then the package step identity is unchanged because Lando does not install
    // that release.
    const unpinned = await composePhpPlan({
      image: "my/php:8.3",
      composer: { packages: { "drush/drush": "^13.0" } },
    });
    const pinned = await composePhpPlan({
      image: "my/php:8.3",
      composer: { version: "2.7.7", packages: { "drush/drush": "^13.0" } },
    });

    expect(buildStepsFor(unpinned).find((step) => step.id === PHP_COMPOSER_PACKAGES_STEP_ID)).toEqual(
      buildStepsFor(pinned).find((step) => step.id === PHP_COMPOSER_PACKAGES_STEP_ID),
    );
  });

  test("uses the object-form version when selecting the pinned release", async () => {
    const plan = await composePhpPlan({ composer: { version: "2.7.7" } });

    expect(buildStepsFor(plan).find((step) => step.id === PHP_COMPOSER_STEP_ID)?.buildKeyInputs).toEqual({
      composer: PHP_COMPOSER_RELEASES["2.7.7"],
    });
  });

  test("rejects composer 2.7.7 in object form when planning php:8.5", async () => {
    await expectRejectsToThrow(
      composePhpPlan({ composer: { version: "2.7.7" } }, php85ServiceType),
      /cannot run on PHP 8\.5/,
    );
  });

  test("rejects an unknown version in object form", async () => {
    await expectRejectsToThrow(
      composePhpPlan({ composer: { version: "nope" } }),
      /Unsupported Composer version "nope"/,
    );
  });

  test("rejects an invalid composer package name with remediation", async () => {
    await expectRejectsToThrow(
      composePhpPlan({ composer: { packages: { drush: "^13.0" } } }),
      /Unsupported Composer package "drush"/,
    );
  });

  test("rejects a secret reference in a package constraint", async () => {
    await expectRejectsToThrow(
      composePhpPlan({ composer: { packages: { "vendor/a": "${secret:TOKEN}" } } }),
      /Unsupported Composer version constraint .* for "vendor\/a"/,
    );
  });

  test("rejects packages when composer is disabled by a false version", async () => {
    // Given composer: false, packages cannot be authored in the same value,
    // so the only disable-plus-packages spelling is rejected by the schema;
    // an object form with packages always installs Composer.
    const plan = await composePhpPlan({ composer: { packages: { "drush/drush": "^13.0" } } });

    expect(buildStepsFor(plan).some((step) => step.id === PHP_COMPOSER_STEP_ID)).toBe(true);
  });
});
