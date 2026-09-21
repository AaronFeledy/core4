import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, type ServiceConfig, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import type { ServiceType } from "@lando/sdk/services";

import { serviceTypes } from "../src/index.ts";
import { LANDO_ERROR_PAGES_BUILD_STEP_ID } from "../src/services/http-errors.ts";
import { phpImageFor } from "../src/services/php-via.ts";
import {
  PHP_FEATURE_ID,
  SUPPORTED_PHP_VERSIONS,
  php81ServiceType,
  php84ServiceType,
  php86ServiceType,
  phpServiceFeature,
} from "../src/services/php.ts";
import { apacheLauncherDirectives } from "./support/apache-directives.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const metadata = {
  resolvedAt: "2026-07-24T00:00:00Z",
  source: "php-wave-d.test.ts",
  runtime: 4 as const,
};

const decodeService = (raw: unknown): ServiceConfig => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "php-wave-d",
    services: { web: raw },
  });
  const service = landofile.services?.[ServiceName.make("web")];
  if (service === undefined) throw new Error("web service missing");
  return service;
};

interface PlannedBuildStep {
  readonly id?: string;
  readonly user?: string;
  readonly command: string | ReadonlyArray<string>;
}

const buildStepsFor = (plan: ServicePlan): ReadonlyArray<PlannedBuildStep> => {
  const features = plan.extensions["@lando/core/service-features"] as
    | { readonly buildSteps?: ReadonlyArray<PlannedBuildStep> }
    | undefined;
  return features?.buildSteps ?? [];
};

const compose = (serviceType: ServiceType, raw: unknown) =>
  composeServicePlan({
    serviceType,
    service: decodeService(raw),
    appRoot: "/srv/apps/php-wave-d",
    appName: "php-wave-d",
    serviceName: "web",
    metadata,
    featureOverrides: new Map([[PHP_FEATURE_ID, phpServiceFeature]]),
  });

describe("PHP Wave D planning", () => {
  test.each(["/app/bad!root", "/app/'quoted", '/app/"quoted', "/app/bad\\root", "/app/bad\nroot"])(
    "rejects unsafe webroot %s at plan time",
    async (webroot) => {
      // Given
      const service = { type: "php:8.1", webroot, allowOverride: true };

      // When
      const planned = compose(php81ServiceType, service);

      // Then
      await expect(planned).rejects.toThrow(/webroot/i);
    },
  );

  test("hands the Apache configuration to the launcher for a validated webroot", async () => {
    // Given
    const service = { type: "php:8.4", webroot: "/app/web", allowOverride: true };

    // When
    const plan = await compose(php84ServiceType, service);

    // Then
    const directives = apacheLauncherDirectives(plan.command, "apache2-foreground");
    expect(directives).toContain('DocumentRoot "/app/web"');
    const open = directives.indexOf('<Directory "/app/web">');
    const close = directives.indexOf("</Directory>");
    expect(open).toBeGreaterThanOrEqual(0);
    expect(close).toBeGreaterThan(open);
    expect(directives.slice(open + 1, close)).toEqual([
      "Options -Indexes +FollowSymLinks",
      "AllowOverride All",
      "Require all granted",
    ]);
  });

  test("Lando-owned Apache serves branded 403 and 404 pages outside the app mount", async () => {
    const plan = await compose(php84ServiceType, {
      type: "php:8.4",
      webroot: "/app/web",
      allowOverride: true,
    });

    const directives = apacheLauncherDirectives(plan.command, "apache2-foreground");
    expect(directives).toContain('Alias "/_lando/errors/" "/usr/share/lando/errors/"');
    expect(directives).toContain("ErrorDocument 403 /_lando/errors/403.html");
    expect(directives).toContain("ErrorDocument 404 /_lando/errors/404.html");
    expect(directives.join("\n")).not.toContain("/app/.lando");

    // The pages are image content now, so no launcher creates them at start.
    const pageStep = buildStepsFor(plan).find((step) => step.id === LANDO_ERROR_PAGES_BUILD_STEP_ID);
    expect(pageStep?.user).toBe("root");
    expect(JSON.stringify(pageStep?.command)).toContain("/usr/share/lando/errors/403.html");
    expect(JSON.stringify(pageStep?.command)).toContain("/usr/share/lando/errors/404.html");
  });

  test.each([
    ["8.1", php81ServiceType],
    ["8.4", php84ServiceType],
    ["8.6", php86ServiceType],
  ] as const)("plans and registers PHP %s", async (version, serviceType) => {
    // Given
    const type = `php:${version}`;

    // When
    const plan = await compose(serviceType, { type });

    // Then
    expect([...SUPPORTED_PHP_VERSIONS]).toContain(version);
    expect(serviceTypes.get(type)).toBe(serviceType);
    expect(plan.type).toBe(type);
    expect(plan.artifact).toEqual({ kind: "ref", ref: phpImageFor(version, "apache") });
  });
});
