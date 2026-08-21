import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { LandofileShape, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import type { ServiceType } from "@lando/sdk/services";

import {
  PHP_FEATURE_ID,
  php81ServiceType,
  php82ServiceType,
  php85ServiceType,
  phpServiceFeature,
} from "../src/services/php.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const PHP_XDEBUG_RELEASE = {
  version: "3.5.3",
  sha256: "f073de91bea046106abf4d6071c963ea71e58571df6ce58948ceca89d121cb2d",
  url: "https://pecl.php.net/get/xdebug-3.5.3.tgz",
} as const;
const PHP_XDEBUG_CLIENT_HOST = "host.docker.internal";
const PHP_XDEBUG_PORT = 9003;

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

const metadata = {
  resolvedAt: "2026-08-20T00:00:00Z",
  source: "/srv/apps/php-xdebug/.lando.yml",
  runtime: 4 as const,
};

const composePhpPlan = (
  overrides: Record<string, unknown> = {},
  serviceType: ServiceType = php82ServiceType,
) => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "php-xdebug",
    services: { web: { type: serviceType.id, ...overrides } },
  });
  const service = landofile.services?.[ServiceName.make("web")];
  if (service === undefined) throw new Error("web service missing");
  return composeServicePlan({
    serviceType,
    service,
    appRoot: "/srv/apps/php-xdebug",
    appName: "php-xdebug",
    serviceName: "web",
    metadata,
    featureOverrides: new Map([[PHP_FEATURE_ID, phpServiceFeature]]),
  });
};

const resolvePhp = (overrides: Record<string, unknown> = {}, serviceType: ServiceType = php82ServiceType) => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "php-xdebug",
    services: { web: { type: serviceType.id, ...overrides } },
  });
  const service = landofile.services?.[ServiceName.make("web")];
  if (service === undefined) throw new Error("web service missing");
  return Effect.runPromise(
    serviceType.resolve({
      name: "web",
      service,
      appRoot: "/srv/apps/php-xdebug",
      appName: "php-xdebug",
      metadata,
    }),
  );
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

describe("PHP xdebug option", () => {
  test("Given no xdebug key, when planning, then it installs nothing and contributes no tooling", async () => {
    const plan = await composePhpPlan();
    const steps = buildStepsFor(plan);
    const resolution = await resolvePhp();

    expect(steps.map(({ id }) => id)).not.toContain("service-lando.php:xdebug");
    expect(plan.environment.XDEBUG_MODE).toBeUndefined();
    expect(plan.environment.XDEBUG_CONFIG).toBeUndefined();
    expect(resolution.tooling?.xdebug).toBeUndefined();
  });

  test("Given xdebug false, when planning, then it installs nothing", async () => {
    const plan = await composePhpPlan({ xdebug: false });
    const steps = buildStepsFor(plan);
    const resolution = await resolvePhp({ xdebug: false });

    expect(steps.map(({ id }) => id)).not.toContain("service-lando.php:xdebug");
    expect(plan.environment.XDEBUG_MODE).toBeUndefined();
    expect(resolution.tooling?.xdebug).toBeUndefined();
  });

  test("Given xdebug true, when planning, then it installs the pinned extension with debug mode and host gateway", async () => {
    const plan = await composePhpPlan({ xdebug: true });
    const steps = buildStepsFor(plan);
    const xdebugStep = steps.find((step) => step.id === "service-lando.php:xdebug");

    expect(xdebugStep?.buildKeyInputs).toEqual({
      xdebug: { ...PHP_XDEBUG_RELEASE, phpVersion: "8.2", mode: "debug" },
    });
    expect(String(xdebugStep?.command)).toContain(PHP_XDEBUG_RELEASE.url);
    expect(String(xdebugStep?.command)).toContain(PHP_XDEBUG_RELEASE.sha256);
    expect(String(xdebugStep?.command)).toContain("xdebug.mode=debug");
    expect(plan.environment.XDEBUG_MODE).toBeUndefined();
    expect(plan.environment.XDEBUG_CONFIG).toBe(
      `client_host=${PHP_XDEBUG_CLIENT_HOST} client_port=${String(PHP_XDEBUG_PORT)}`,
    );
  });

  test("Given an explicit mode string, when planning, then xdebug.mode and buildKey use that mode", async () => {
    const plan = await composePhpPlan({ xdebug: "debug,develop" });
    const xdebugStep = buildStepsFor(plan).find((step) => step.id === "service-lando.php:xdebug");

    expect(String(xdebugStep?.command)).toContain("xdebug.mode=debug,develop");
    expect(xdebugStep?.buildKeyInputs).toMatchObject({
      xdebug: { mode: "debug,develop", version: PHP_XDEBUG_RELEASE.version },
    });
  });

  test("Given xdebug true, when resolving, then it contributes on/off/status tooling", async () => {
    const resolution = await resolvePhp({ xdebug: true });
    const task = resolution.tooling?.xdebug;

    expect(task).toBeDefined();
    expect(task?.service).toBe("web");
    const command = Array.isArray(task?.cmd) ? task.cmd.join(" ") : String(task?.cmd ?? "");
    expect(command).toMatch(/\bon\b/);
    expect(command).toMatch(/\boff\b/);
    expect(command).toMatch(/\bstatus\b/);
  });

  test.each(["apache", "fpm", "cli"] as const)(
    "Given via %s and xdebug true, when resolving, then tooling reloads that serving mode",
    async (via) => {
      const resolution = await resolvePhp({ xdebug: true, via });
      const task = resolution.tooling?.xdebug;
      const command = Array.isArray(task?.cmd) ? task.cmd.join(" ") : String(task?.cmd ?? "");

      expect(task).toBeDefined();
      if (via === "apache") expect(command).toMatch(/apache2ctl|USR1/);
      if (via === "fpm") expect(command).toMatch(/USR2/);
      if (via === "cli") expect(command).toMatch(/status/);
    },
  );

  test("Given PHP 8.1 and 8.5, when xdebug is true, then each build key includes that PHP version", async () => {
    const php81 = buildStepsFor(await composePhpPlan({ xdebug: true }, php81ServiceType)).find(
      (step) => step.id === "service-lando.php:xdebug",
    );
    const php85 = buildStepsFor(await composePhpPlan({ xdebug: true }, php85ServiceType)).find(
      (step) => step.id === "service-lando.php:xdebug",
    );

    expect(php81?.buildKeyInputs).toMatchObject({ xdebug: { phpVersion: "8.1" } });
    expect(php85?.buildKeyInputs).toMatchObject({ xdebug: { phpVersion: "8.5" } });
    expect(php81?.buildKeyInputs).not.toEqual(php85?.buildKeyInputs);
  });

  test("Given composer false and xdebug true, when planning, then Xdebug still installs", async () => {
    const steps = buildStepsFor(await composePhpPlan({ composer: false, xdebug: true }));

    expect(steps.map(({ id }) => id)).toEqual([
      "lando.boot:scaffold",
      "service-lando.php:prerequisites",
      "service-lando.php:xdebug",
    ]);
  });

  test("Given an unknown mode, when planning, then it fails closed with remediation", async () => {
    const planned = composePhpPlan({ xdebug: "nope" });
    await expectRejectsToThrow(planned, /Unsupported Xdebug mode/);
    await expectRejectsToThrow(planned, /xdebug: true/);
    await expectRejectsToThrow(planned, /xdebug: false/);
  });

  test("Given xdebug off as a mode string, when planning, then it fails closed with remediation", async () => {
    const planned = composePhpPlan({ xdebug: "off" });
    await expectRejectsToThrow(planned, /runtime toggle/);
    await expectRejectsToThrow(planned, /xdebug: true/);
  });

  test("Given a custom image and invalid xdebug, when planning, then it still fails closed", async () => {
    const planned = composePhpPlan({ image: "registry.example.com/php:8.2-custom", xdebug: "nope" });
    await expectRejectsToThrow(planned, /Unsupported Xdebug mode/);
  });

  test("Given a custom image and xdebug true, when planning, then it skips the install step without XDEBUG_MODE", async () => {
    const plan = await composePhpPlan({ image: "registry.example.com/php:8.2-custom", xdebug: true });
    const resolution = await resolvePhp({ image: "registry.example.com/php:8.2-custom", xdebug: true });

    expect(buildStepsFor(plan).map(({ id }) => id)).toEqual(["lando.boot:scaffold"]);
    expect(plan.environment.XDEBUG_MODE).toBeUndefined();
    expect(plan.environment.XDEBUG_CONFIG).toBe(
      `client_host=${PHP_XDEBUG_CLIENT_HOST} client_port=${String(PHP_XDEBUG_PORT)}`,
    );
    expect(resolution.tooling?.xdebug).toBeDefined();
  });
});
