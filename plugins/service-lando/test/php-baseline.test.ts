import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import type { ServiceType } from "@lando/sdk/services";

import {
  PHP_BASELINE_INI_PATH,
  PHP_BASELINE_STEP_ID,
  PHP_SECURITY_BASELINE,
  phpBaselineBuildStep,
  phpBaselineIniCommand,
  renderPhpBaselineIni,
} from "../src/services/php-baseline.ts";
import { PHP_FEATURE_ID, php82ServiceType, phpServiceFeature } from "../src/services/php.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const BuildSteps = Schema.Struct({
  buildSteps: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.optionalKey(Schema.String),
        command: Schema.Unknown,
        user: Schema.optionalKey(Schema.String),
        buildKeyInputs: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
      }),
    ),
  ),
});

const composePhpPlan = (
  overrides: Record<string, unknown> = {},
  serviceType: ServiceType = php82ServiceType,
): Promise<ServicePlan> => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "php-baseline",
    services: { web: { type: serviceType.id, ...overrides } },
  });
  const service = landofile.services?.[ServiceName.make("web")];
  if (service === undefined) throw new Error("web service missing");
  return composeServicePlan({
    serviceType,
    service,
    appRoot: "/srv/apps/php-baseline",
    appName: "php-baseline",
    serviceName: "web",
    metadata: {
      resolvedAt: "2026-10-25T00:00:00Z",
      source: "/srv/apps/php-baseline/.lando.yml",
      runtime: 4,
    },
    featureOverrides: new Map([[PHP_FEATURE_ID, phpServiceFeature]]),
  });
};

const buildStepsFor = (plan: ServicePlan) =>
  Schema.decodeUnknownSync(BuildSteps)(plan.extensions["@lando/core/service-features"]).buildSteps ?? [];

const baselineIni = renderPhpBaselineIni();

describe("PHP security baseline table", () => {
  test("renders table settings into a conf.d ini that cites the advisory", () => {
    // Given / When: the stock baseline table is rendered.
    // Then: comments cite the advisory and the setting is assigned, without version pins.
    expect(baselineIni.endsWith("\n")).toBe(true);
    expect(baselineIni).toContain("; Lando-managed PHP security baseline\n");
    expect(baselineIni).not.toMatch(/\b\d+\.\d+\.\d+\b/u);
    for (const entry of PHP_SECURITY_BASELINE) {
      expect(baselineIni).toContain(`; ${entry.reason}`);
      expect(baselineIni).toContain(`; Advisory: ${entry.advisoryUrl}`);
      expect(baselineIni).not.toContain(entry.removeWhen);
      expect(baselineIni).toContain(`${entry.setting} = ${entry.value}\n`);
    }
    expect(baselineIni).toContain("https://www.php.net/archive/2026.php#2026-10-23-1");
    expect(baselineIni).toContain("session.upload_progress.enabled = 0\n");
  });

  test("requires an advisory URL and a non-empty removal trigger on every entry", () => {
    expect(PHP_SECURITY_BASELINE.length).toBeGreaterThan(0);
    for (const entry of PHP_SECURITY_BASELINE) {
      expect(entry.advisoryUrl.length).toBeGreaterThan(0);
      expect(entry.removeWhen.length).toBeGreaterThan(0);
    }
  });
});

describe("PHP security baseline plan", () => {
  test.each(["apache", "fpm", "cli"] as const)(
    "writes 10-lando-baseline.ini on stock images via %s",
    async (via) => {
      // Given / When: compose a stock PHP service.
      const plan = await composePhpPlan({ via });
      const step = buildStepsFor(plan).find((candidate) => candidate.id === PHP_BASELINE_STEP_ID);

      // Then: the Lando-managed conf.d file is a root build step keyed by the table.
      expect(step?.user).toBe("root");
      expect(step?.command).not.toMatch(/[\r\n\p{Cc}]/u);
      expect(step?.command).toContain(phpBaselineIniCommand(baselineIni));
      expect(step?.command).toContain(PHP_BASELINE_INI_PATH);
      expect(step?.buildKeyInputs).toEqual({
        phpBaseline: {
          path: PHP_BASELINE_INI_PATH,
          content: baselineIni,
          entries: PHP_SECURITY_BASELINE,
        },
      });
    },
  );

  test("omits the baseline file when image is custom", async () => {
    // Given / When: a custom image opts out of stock PHP provisioning.
    const plan = await composePhpPlan({ image: "registry.example.com/php:8.2-custom" });

    // Then: no baseline conf.d file is written.
    expect(plan.artifact).toEqual({ kind: "ref", ref: "registry.example.com/php:8.2-custom" });
    expect(buildStepsFor(plan).some((step) => step.id === PHP_BASELINE_STEP_ID)).toBe(false);
    expect(JSON.stringify(buildStepsFor(plan))).not.toContain(PHP_BASELINE_INI_PATH);
  });

  test("emits no build step when the table is empty", () => {
    expect(phpBaselineBuildStep([])).toBeUndefined();
  });
});
