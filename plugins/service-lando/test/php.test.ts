import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, type ServiceConfig, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import type { ServiceType } from "@lando/sdk/services";

import {
  PHP_FEATURE_ID,
  SUPPORTED_PHP_FRAMEWORKS,
  SUPPORTED_PHP_VERSIONS,
  php82ServiceType,
  php83ServiceType,
  phpServiceFeature,
} from "../src/services/php.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const metadata = {
  resolvedAt: "2026-05-17T22:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const APP_ROOT = "/srv/apps/myapp";
const archiveSupportId = "service-lando.php:archive-support";
const commonExtensionsId = "service-lando.php:common-extensions";
const composerId = "service-lando.php:composer";
const featureOverrides = new Map([[PHP_FEATURE_ID, phpServiceFeature]]);
const BuildSteps = Schema.Struct({ buildSteps: Schema.optional(Schema.Array(Schema.Unknown)) });

const buildStepsFor = (plan: ServicePlan): ReadonlyArray<unknown> =>
  Schema.decodeUnknownSync(BuildSteps)(plan.extensions["@lando/core/service-features"]).buildSteps ?? [];
const isArchiveSupport = (x: unknown) =>
  x !== null && typeof x === "object" && Reflect.get(x, "id") === archiveSupportId;
const isCommonExtensions = (x: unknown) =>
  x !== null && typeof x === "object" && Reflect.get(x, "id") === commonExtensionsId;
const isComposer = (x: unknown) => x !== null && typeof x === "object" && Reflect.get(x, "id") === composerId;

const decodeService = (raw: unknown): ServiceConfig => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "myapp",
    services: { web: raw },
  });
  const service = landofile.services?.[ServiceName.make("web")];
  if (service === undefined) throw new Error("web service missing");
  return service;
};

const composePhpPlan = (serviceType: ServiceType, raw: unknown, appRoot = APP_ROOT): Promise<ServicePlan> =>
  composeServicePlan({
    serviceType,
    service: decodeService(raw),
    appRoot,
    appName: "myapp",
    serviceName: "web",
    metadata,
    featureOverrides,
  });

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

describe("php ServiceType — supported versions and frameworks", () => {
  test("exposes 8.2 and 8.3 as supported versions", () => {
    expect([...SUPPORTED_PHP_VERSIONS]).toEqual(["8.2", "8.3"]);
  });

  test("exposes drupal, wordpress, laravel, symfony, none as supported frameworks", () => {
    expect([...SUPPORTED_PHP_FRAMEWORKS]).toEqual(["drupal", "wordpress", "laravel", "symfony", "none"]);
  });
});

describe("php:8.2 ServiceType", () => {
  test("plans a default PHP 8.2 web service with framework=none defaults", async () => {
    const plan = await composePhpPlan(php82ServiceType, { type: "php:8.2" });

    expect(plan.type).toBe("php:8.2");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "php:8.2-apache" });
    const buildSteps = buildStepsFor(plan);
    const archiveSteps = buildSteps.filter(isArchiveSupport);
    const commonExtensionSteps = buildSteps.filter(isCommonExtensions);
    const composerSteps = buildSteps.filter(isComposer);
    expect(archiveSteps).toHaveLength(1);
    expect(JSON.stringify(archiveSteps[0])).toMatch(
      /apt-get update.*apt-get install -y --no-install-recommends unzip.*rm -rf \/var\/lib\/apt\/lists\/\*/,
    );
    expect(commonExtensionSteps).toHaveLength(1);
    expect(JSON.stringify(commonExtensionSteps[0])).toMatch(
      /apt-get update.*libfreetype6-dev.*libicu-dev.*libjpeg62-turbo-dev.*libpng-dev.*libpq-dev.*libzip-dev.*docker-php-ext-configure gd --with-freetype --with-jpeg.*docker-php-ext-install.*gd intl pdo_mysql pdo_pgsql zip.*rm -rf \/var\/lib\/apt\/lists\/\*/,
    );
    expect(composerSteps).toHaveLength(1);
    expect(JSON.stringify(composerSteps[0])).toMatch(
      /^(?=.*"phase":"build")(?=.*"command":"trap 'status=\$\?; trap - 0; rm -f composer-setup\.php; exit .*status.*' 0; php -r .*https:\/\/composer\.github\.io\/installer\.sig.*https:\/\/getcomposer\.org\/installer.*\$checksum = hash_file.*sha384.*\$checksum === false \|\| !hash_equals.*&& php composer-setup\.php --2 --install-dir=\/usr\/local\/bin --filename=composer).*$/,
    );
    expect(buildSteps.findIndex(isArchiveSupport)).toBeLessThan(buildSteps.findIndex(isComposer));
    expect(buildSteps.findIndex(isCommonExtensions)).toBeLessThan(buildSteps.findIndex(isComposer));
    expect(plan.primary).toBe(true);
    expect(String(plan.workingDirectory)).toBe("/app");

    expect(String(plan.appMount?.source)).toBe(APP_ROOT);
    expect(String(plan.appMount?.target)).toBe("/app");
    expect(plan.appMount?.readOnly).toBe(false);

    expect(plan.mounts).toHaveLength(1);
    expect(plan.mounts[0]?.type).toBe("bind");
    expect(plan.mounts[0]?.source).toBe(APP_ROOT);
    expect(String(plan.mounts[0]?.target)).toBe("/app");

    expect(plan.endpoints).toEqual([{ port: 80, protocol: "http", name: "web" }]);

    expect(plan.healthcheck).toEqual({
      kind: "command",
      command: ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/80"],
      intervalSeconds: 10,
      timeoutSeconds: 5,
      retries: 5,
      startPeriodSeconds: 10,
    });

    expect(plan.environment).toMatchObject({
      LANDO: "ON",
      LANDO_APP_NAME: "myapp",
      LANDO_APP_KIND: "user",
      LANDO_APP_ROOT: "/app",
      LANDO_PROJECT: "myapp",
      LANDO_PROJECT_MOUNT: "/app",
      LANDO_SERVICE_API: "4",
      LANDO_SERVICE_NAME: "web",
      LANDO_SERVICE_TYPE: "php:8.2",
      LANDO_WEBROOT: "/app",
      APACHE_DOCUMENT_ROOT: "/app",
    });

    expect(plan.extensions["lando-service-php"]).toEqual({
      framework: "none",
      webroot: "/app",
      version: "8.2",
    });
  });

  test("derives appName from appRoot basename when no explicit appName is provided", async () => {
    const plan = await composeServicePlan({
      serviceType: php82ServiceType,
      service: decodeService({ type: "php:8.2" }),
      appRoot: "/srv/apps/anotherapp",
      serviceName: "web",
      metadata,
      featureOverrides,
    });

    expect(plan.environment.LANDO_APP_NAME).toBe("anotherapp");
    expect(plan.environment.LANDO_PROJECT).toBe("anotherapp");
  });

  test("framework=drupal sets webroot to /app/web and matching APACHE_DOCUMENT_ROOT", async () => {
    const plan = await composePhpPlan(php82ServiceType, { type: "php:8.2", framework: "drupal" });

    expect(String(plan.workingDirectory)).toBe("/app/web");
    expect(plan.environment.APACHE_DOCUMENT_ROOT).toBe("/app/web");
    expect(plan.environment.LANDO_WEBROOT).toBe("/app/web");
    expect(plan.extensions["lando-service-php"]).toMatchObject({ framework: "drupal", webroot: "/app/web" });
  });

  test("framework=wordpress keeps the app root as webroot", async () => {
    const plan = await composePhpPlan(php82ServiceType, { type: "php:8.2", framework: "wordpress" });

    expect(String(plan.workingDirectory)).toBe("/app");
    expect(plan.environment.APACHE_DOCUMENT_ROOT).toBe("/app");
    expect(plan.environment.LANDO_WEBROOT).toBe("/app");
    expect(plan.extensions["lando-service-php"]).toMatchObject({ framework: "wordpress" });
  });

  test("framework=laravel sets webroot to /app/public", async () => {
    const plan = await composePhpPlan(php82ServiceType, { type: "php:8.2", framework: "laravel" });

    expect(String(plan.workingDirectory)).toBe("/app/public");
    expect(plan.environment.APACHE_DOCUMENT_ROOT).toBe("/app/public");
  });

  test("framework=symfony sets webroot to /app/public", async () => {
    const plan = await composePhpPlan(php82ServiceType, { type: "php:8.2", framework: "symfony" });

    expect(String(plan.workingDirectory)).toBe("/app/public");
    expect(plan.environment.APACHE_DOCUMENT_ROOT).toBe("/app/public");
  });

  test("user environment overrides framework defaults", async () => {
    const plan = await composePhpPlan(php82ServiceType, {
      type: "php:8.2",
      framework: "drupal",
      environment: { APACHE_DOCUMENT_ROOT: "/app/custom", FOO: "bar" },
    });

    expect(plan.environment.APACHE_DOCUMENT_ROOT).toBe("/app/custom");
    expect(plan.environment.LANDO_WEBROOT).toBe("/app/web");
    expect(plan.environment.FOO).toBe("bar");
  });

  test("propagates user image override and custom port", async () => {
    const plan = await composePhpPlan(php82ServiceType, {
      type: "php:8.2",
      image: "registry.example.com/php:8.2-custom",
      port: 8080,
    });

    expect(plan.artifact).toEqual({ kind: "ref", ref: "registry.example.com/php:8.2-custom" });
    expect(buildStepsFor(plan).filter(isArchiveSupport)).toHaveLength(0);
    expect(buildStepsFor(plan).filter(isCommonExtensions)).toHaveLength(0);
    expect(buildStepsFor(plan).filter(isComposer)).toHaveLength(0);
    expect(plan.endpoints).toEqual([{ port: 8080, protocol: "http", name: "web" }]);
    expect(plan.healthcheck?.kind).toBe("command");
    expect(plan.healthcheck?.command).toEqual(["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/8080"]);
  });

  test("rejects unsupported framework values with a remediation in the error", async () => {
    await expectRejectsToThrow(
      composePhpPlan(php82ServiceType, { type: "php:8.2", framework: "magento" }),
      /Unsupported PHP framework "magento"\./,
    );

    await expectRejectsToThrow(
      composePhpPlan(php82ServiceType, { type: "php:8.2", framework: "magento" }),
      /Set framework to one of: drupal, wordpress, laravel, symfony, none/,
    );
  });
});

describe("php:8.3 ServiceType", () => {
  test("plans a default PHP 8.3 service", async () => {
    const plan = await composePhpPlan(php83ServiceType, { type: "php:8.3" });

    expect(plan.type).toBe("php:8.3");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "php:8.3-apache" });
    expect(plan.environment.LANDO_SERVICE_TYPE).toBe("php:8.3");
    expect(plan.extensions["lando-service-php"]).toMatchObject({ version: "8.3" });
  });

  test("rejects unsupported PHP versions with remediation", async () => {
    await expectRejectsToThrow(
      composePhpPlan(php83ServiceType, { type: "php:8.1" }),
      /Unsupported PHP version "8.1"\./,
    );

    await expectRejectsToThrow(
      composePhpPlan(php83ServiceType, { type: "php:8.1" }),
      /Set type to one of: php:8.2, php:8.3/,
    );
  });

  test("rejects php:8.4 and other unsupported versions on the 8.2 service type too", async () => {
    await expectRejectsToThrow(
      composePhpPlan(php82ServiceType, { type: "php:8.4" }),
      /Unsupported PHP version "8.4"/,
    );
  });

  test("rejects user environment that targets reserved LANDO_* keys", async () => {
    await expectRejectsToThrow(
      composePhpPlan(php82ServiceType, {
        type: "php:8.2",
        environment: { LANDO_PROJECT: "evil", FOO: "bar" },
      }),
      /reserved LANDO_\* keys.*LANDO_PROJECT/,
    );
  });

  test("rejects bare reserved key 'LANDO' on user environment", async () => {
    await expectRejectsToThrow(
      composePhpPlan(php82ServiceType, {
        type: "php:8.2",
        environment: { LANDO: "OFF" },
      }),
      /reserved LANDO_\* keys.*LANDO/,
    );
  });
});
