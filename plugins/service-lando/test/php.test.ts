import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, type ServiceConfig, ServiceName } from "@lando/sdk/schema";

import {
  SUPPORTED_PHP_FRAMEWORKS,
  SUPPORTED_PHP_VERSIONS,
  php82ServiceType,
  php83ServiceType,
} from "../src/services/php.ts";

const metadata = {
  resolvedAt: "2026-05-17T22:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const APP_ROOT = "/srv/apps/myapp";

const decodeService = (raw: unknown): ServiceConfig => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "myapp",
    services: { web: raw },
  });
  const service = landofile.services?.[ServiceName.make("web")];
  if (service === undefined) throw new Error("web service missing");
  return service;
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
  test("plans a default PHP 8.2 web service with framework=none defaults", () => {
    const service = decodeService({ type: "php:8.2" });
    const plan = php82ServiceType.toServicePlan({
      name: "web",
      service,
      appRoot: APP_ROOT,
      appName: "myapp",
      metadata,
    });

    expect(plan.type).toBe("php:8.2");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "php:8.2-apache" });
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
      kind: "tcp",
      port: 80,
      intervalSeconds: 10,
      timeoutSeconds: 5,
      retries: 5,
      startPeriodSeconds: 10,
    });

    expect(plan.environment.LANDO).toBe("ON");
    expect(plan.environment.LANDO_APP_NAME).toBe("myapp");
    expect(plan.environment.LANDO_APP_KIND).toBe("user");
    expect(plan.environment.LANDO_APP_ROOT).toBe("/app");
    expect(plan.environment.LANDO_PROJECT).toBe("myapp");
    expect(plan.environment.LANDO_PROJECT_MOUNT).toBe("/app");
    expect(plan.environment.LANDO_SERVICE_API).toBe("4");
    expect(plan.environment.LANDO_SERVICE_NAME).toBe("web");
    expect(plan.environment.LANDO_SERVICE_TYPE).toBe("php:8.2");

    expect(plan.environment.LANDO_WEBROOT).toBe("/app");
    expect(plan.environment.APACHE_DOCUMENT_ROOT).toBe("/app");

    expect(plan.extensions["lando-service-php"]).toEqual({
      framework: "none",
      webroot: "/app",
      version: "8.2",
    });
  });

  test("derives appName from appRoot basename when no explicit appName is provided", () => {
    const service = decodeService({ type: "php:8.2" });
    const plan = php82ServiceType.toServicePlan({
      name: "web",
      service,
      appRoot: "/srv/apps/anotherapp",
      metadata,
    });
    expect(plan.environment.LANDO_APP_NAME).toBe("anotherapp");
    expect(plan.environment.LANDO_PROJECT).toBe("anotherapp");
  });

  test("framework=drupal sets webroot to /app/web and matching APACHE_DOCUMENT_ROOT", () => {
    const service = decodeService({ type: "php:8.2", framework: "drupal" });
    const plan = php82ServiceType.toServicePlan({
      name: "web",
      service,
      appRoot: APP_ROOT,
      appName: "myapp",
      metadata,
    });

    expect(String(plan.workingDirectory)).toBe("/app/web");
    expect(plan.environment.APACHE_DOCUMENT_ROOT).toBe("/app/web");
    expect(plan.environment.LANDO_WEBROOT).toBe("/app/web");
    expect(plan.extensions["lando-service-php"]).toMatchObject({ framework: "drupal", webroot: "/app/web" });
  });

  test("framework=wordpress keeps the app root as webroot", () => {
    const service = decodeService({ type: "php:8.2", framework: "wordpress" });
    const plan = php82ServiceType.toServicePlan({
      name: "web",
      service,
      appRoot: APP_ROOT,
      appName: "myapp",
      metadata,
    });

    expect(String(plan.workingDirectory)).toBe("/app");
    expect(plan.environment.APACHE_DOCUMENT_ROOT).toBe("/app");
    expect(plan.environment.LANDO_WEBROOT).toBe("/app");
    expect(plan.extensions["lando-service-php"]).toMatchObject({ framework: "wordpress" });
  });

  test("framework=laravel sets webroot to /app/public", () => {
    const service = decodeService({ type: "php:8.2", framework: "laravel" });
    const plan = php82ServiceType.toServicePlan({
      name: "web",
      service,
      appRoot: APP_ROOT,
      appName: "myapp",
      metadata,
    });

    expect(String(plan.workingDirectory)).toBe("/app/public");
    expect(plan.environment.APACHE_DOCUMENT_ROOT).toBe("/app/public");
  });

  test("framework=symfony sets webroot to /app/public", () => {
    const service = decodeService({ type: "php:8.2", framework: "symfony" });
    const plan = php82ServiceType.toServicePlan({
      name: "web",
      service,
      appRoot: APP_ROOT,
      appName: "myapp",
      metadata,
    });

    expect(String(plan.workingDirectory)).toBe("/app/public");
    expect(plan.environment.APACHE_DOCUMENT_ROOT).toBe("/app/public");
  });

  test("user environment overrides framework defaults", () => {
    const service = decodeService({
      type: "php:8.2",
      framework: "drupal",
      environment: { APACHE_DOCUMENT_ROOT: "/app/custom", FOO: "bar" },
    });
    const plan = php82ServiceType.toServicePlan({
      name: "web",
      service,
      appRoot: APP_ROOT,
      appName: "myapp",
      metadata,
    });

    expect(plan.environment.APACHE_DOCUMENT_ROOT).toBe("/app/custom");
    expect(plan.environment.LANDO_WEBROOT).toBe("/app/web");
    expect(plan.environment.FOO).toBe("bar");
  });

  test("propagates user image override and custom port", () => {
    const service = decodeService({
      type: "php:8.2",
      image: "registry.example.com/php:8.2-custom",
      port: 8080,
    });
    const plan = php82ServiceType.toServicePlan({
      name: "web",
      service,
      appRoot: APP_ROOT,
      appName: "myapp",
      metadata,
    });

    expect(plan.artifact).toEqual({ kind: "ref", ref: "registry.example.com/php:8.2-custom" });
    expect(plan.endpoints).toEqual([{ port: 8080, protocol: "http", name: "web" }]);
    expect(plan.healthcheck?.port).toBe(8080);
  });

  test("rejects unsupported framework values with a remediation in the error", () => {
    const service = decodeService({ type: "php:8.2", framework: "magento" });
    expect(() =>
      php82ServiceType.toServicePlan({
        name: "web",
        service,
        appRoot: APP_ROOT,
        appName: "myapp",
        metadata,
      }),
    ).toThrow(/Unsupported PHP framework "magento"\./);

    expect(() =>
      php82ServiceType.toServicePlan({
        name: "web",
        service,
        appRoot: APP_ROOT,
        appName: "myapp",
        metadata,
      }),
    ).toThrow(/Set framework to one of: drupal, wordpress, laravel, symfony, none/);
  });
});

describe("php:8.3 ServiceType", () => {
  test("plans a default PHP 8.3 service", () => {
    const service = decodeService({ type: "php:8.3" });
    const plan = php83ServiceType.toServicePlan({
      name: "web",
      service,
      appRoot: APP_ROOT,
      appName: "myapp",
      metadata,
    });

    expect(plan.type).toBe("php:8.3");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "php:8.3-apache" });
    expect(plan.environment.LANDO_SERVICE_TYPE).toBe("php:8.3");
    expect(plan.extensions["lando-service-php"]).toMatchObject({ version: "8.3" });
  });

  test("rejects unsupported PHP versions with remediation", () => {
    const service = decodeService({ type: "php:8.1" });
    expect(() =>
      php83ServiceType.toServicePlan({
        name: "web",
        service,
        appRoot: APP_ROOT,
        appName: "myapp",
        metadata,
      }),
    ).toThrow(/Unsupported PHP version "8.1"\./);

    expect(() =>
      php83ServiceType.toServicePlan({
        name: "web",
        service,
        appRoot: APP_ROOT,
        appName: "myapp",
        metadata,
      }),
    ).toThrow(/Set type to one of: php:8.2, php:8.3/);
  });

  test("rejects php:8.4 and other unsupported versions on the 8.2 service type too", () => {
    const service = decodeService({ type: "php:8.4" });
    expect(() =>
      php82ServiceType.toServicePlan({
        name: "web",
        service,
        appRoot: APP_ROOT,
        appName: "myapp",
        metadata,
      }),
    ).toThrow(/Unsupported PHP version "8.4"/);
  });
});
