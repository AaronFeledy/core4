import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, type ServiceConfig, ServiceName } from "@lando/sdk/schema";
import type { ServiceType } from "@lando/sdk/services";

import { serviceTypes } from "../src/index.ts";
import {
  PHP_FEATURE_ID,
  SUPPORTED_PHP_VERSIONS,
  php81ServiceType,
  php84ServiceType,
  phpServiceFeature,
} from "../src/services/php.ts";
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

  test("renders the exact Apache site config for a validated webroot", async () => {
    // Given
    const service = { type: "php:8.4", webroot: "/app/web", allowOverride: true };

    // When
    const plan = await compose(php84ServiceType, service);

    // Then
    expect(plan.command).toEqual([
      "sh",
      "-c",
      [
        "set -eu",
        "cat > /etc/apache2/sites-available/000-default.conf <<'LANDO_APACHE_SITE'",
        "<VirtualHost *:80>",
        "  DocumentRoot /app/web",
        "  <Directory /app/web>",
        "    Options -Indexes +FollowSymLinks",
        "    AllowOverride All",
        "    Require all granted",
        "  </Directory>",
        "</VirtualHost>",
        "LANDO_APACHE_SITE",
        "exec apache2-foreground",
      ].join("\n"),
    ]);
  });

  test.each([
    ["8.1", php81ServiceType],
    ["8.4", php84ServiceType],
  ] as const)("plans and registers PHP %s", async (version, serviceType) => {
    // Given
    const type = `php:${version}`;

    // When
    const plan = await compose(serviceType, { type });

    // Then
    expect([...SUPPORTED_PHP_VERSIONS]).toContain(version);
    expect(serviceTypes.get(type)).toBe(serviceType);
    expect(plan.type).toBe(type);
    expect(plan.artifact).toEqual({ kind: "ref", ref: `${type}-apache-bookworm` });
  });
});
