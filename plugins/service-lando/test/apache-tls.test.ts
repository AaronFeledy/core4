import { describe, expect, test } from "bun:test";
import { LandofileShape, type ServiceConfig, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import type { ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";
import { Effect, Schema } from "effect";

import {
  APACHE_FEATURE_ID,
  APACHE_SSL_MODULE_BUILD_STEP_ID,
  APACHE_SSL_PORTS_BUILD_STEP_ID,
  apacheServiceFeature,
  apacheServiceType,
} from "../src/services/apache.ts";
import { PHP_FEATURE_ID, php83ServiceType, phpServiceFeature } from "../src/services/php.ts";
import { apacheLauncherDirectives } from "./support/apache-directives.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const metadata = {
  resolvedAt: "2026-05-18T08:00:00Z",
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

interface PlannedBuildStep {
  readonly id?: string;
  readonly user?: string;
  readonly command: string | ReadonlyArray<string>;
}

const buildStepIds = (plan: ServicePlan): ReadonlyArray<string> => {
  const features = plan.extensions["@lando/core/service-features"] as
    | { readonly buildSteps?: ReadonlyArray<PlannedBuildStep> }
    | undefined;
  return (features?.buildSteps ?? []).flatMap((step) => (step.id === undefined ? [] : [step.id]));
};

const buildStepScript = (plan: ServicePlan, id: string): string => {
  const features = plan.extensions["@lando/core/service-features"] as
    | { readonly buildSteps?: ReadonlyArray<PlannedBuildStep> }
    | undefined;
  const step = (features?.buildSteps ?? []).find((entry) => entry.id === id);
  return String((step?.command as ReadonlyArray<string> | undefined)?.[2] ?? "");
};

const composePlan = (
  serviceType: ServiceType,
  raw: unknown,
  featureOverrides: ReadonlyMap<string, ServiceFeatureDefinition>,
): Promise<ServicePlan> =>
  composeServicePlan({
    serviceType,
    service: decodeService(raw),
    appRoot: APP_ROOT,
    appName: "myapp",
    serviceName: "web",
    metadata,
    featureOverrides,
  });

const composePhp = (raw: unknown) =>
  composePlan(php83ServiceType, raw, new Map([[PHP_FEATURE_ID, phpServiceFeature]]));
const composeApache = (raw: unknown) =>
  composePlan(apacheServiceType, raw, new Map([[APACHE_FEATURE_ID, apacheServiceFeature]]));

const phpDirectives = (plan: ServicePlan) => apacheLauncherDirectives(plan.command, "apache2-foreground");
const apacheDirectives = (plan: ServicePlan) => apacheLauncherDirectives(plan.command, "httpd-foreground");

describe("generated Apache native TLS", () => {
  test("php via apache declares a plain and a generated HTTPS listener", async () => {
    // Given / When
    const plan = await composePhp({ type: "php:8.3", via: "apache", certs: true });
    // Then
    expect(plan.endpoints).toEqual([
      { _tag: "internal", port: 80, protocol: "http", name: "web", primary: true },
      { _tag: "internal", port: 443, protocol: "https", name: "web-https" },
    ]);
  });

  test("php via apache renders one TLS virtual host and keeps SetEnvIf on the plain one", async () => {
    // Given
    const plan = await composePhp({ type: "php:8.3", via: "apache", certs: true });
    // When
    const directives = phpDirectives(plan);
    // Then
    expect(directives.filter((directive) => directive === "<VirtualHost *:443>")).toHaveLength(1);
    expect(directives).toContain("<VirtualHost *:80>");
    expect(directives).toContain("ServerName localhost:80");
    expect(directives).toContain("ServerName web.myapp.internal:443");
    expect(directives).toContain("SSLEngine on");
    expect(directives).toContain("SSLEngine off");
    expect(directives).toContain('SSLCertificateFile "${LANDO_SERVICE_CERT}"');
    expect(directives).toContain('SSLCertificateKeyFile "${LANDO_SERVICE_KEY}"');
    expect(directives).toContain("UseCanonicalName Off");
    expect(directives).toContain("UseCanonicalPhysicalPort Off");
    expect(directives).toContain("Listen 443");
    const forwarded = directives.filter((directive) => directive.startsWith("SetEnvIf X-Forwarded-Proto"));
    expect(forwarded).toHaveLength(1);
    expect(directives.indexOf(forwarded[0] ?? "")).toBeLessThan(directives.indexOf("<VirtualHost *:443>"));
  });

  test("php via apache enables Debian ssl and retires ports.conf conditional listeners", async () => {
    // Given / When
    const plan = await composePhp({ type: "php:8.3", via: "apache", certs: true });
    const script = buildStepScript(plan, APACHE_SSL_PORTS_BUILD_STEP_ID);
    // Then
    expect(buildStepIds(plan)).toContain(APACHE_SSL_PORTS_BUILD_STEP_ID);
    expect(script).toContain("a2enmod ssl");
    expect(script).toContain("/etc/apache2/ports.conf");
    expect(script).toContain("IfModule ssl_module");
  });

  test("fpm and cli never gain a native TLS listener", async () => {
    // Given / When
    const fpm = await composePhp({ type: "php:8.3", via: "fpm", certs: true });
    const cli = await composePhp({ type: "php:8.3", via: "cli", certs: true });
    // Then
    expect(fpm.endpoints?.some((endpoint) => endpoint.protocol === "https")).toBe(false);
    expect(cli.endpoints).toEqual([]);
    expect(buildStepIds(fpm)).not.toContain(APACHE_SSL_PORTS_BUILD_STEP_ID);
  });

  test.each([
    { label: "certs false", raw: { type: "php:8.3", via: "apache", certs: false } },
    {
      label: "custom certificate material",
      raw: { type: "php:8.3", via: "apache", certs: "certs/site.crt" },
    },
    { label: "non-root parent", raw: { type: "php:8.3", via: "apache", certs: true, user: "www-data" } },
    {
      label: "authored command",
      raw: { type: "php:8.3", via: "apache", certs: true, command: ["start"] },
      launcher: false,
    },
    {
      label: "custom image",
      raw: { type: "php:8.3", via: "apache", certs: true, image: "registry.example.com/php:8.3-custom" },
      launcher: false,
    },
  ] as const)("php keeps only the plain listener for $label", async ({ raw, launcher }) => {
    // Given / When
    const plan = await composePhp(raw);
    // Then: no TLS listener or certificate material is configured. The plain
    // forwarded-scheme projection belongs to Lando's generated launcher only.
    expect(plan.endpoints?.some((endpoint) => endpoint.protocol === "https")).toBe(false);
    if (launcher !== false) {
      expect(phpDirectives(plan)).toContain('SetEnvIf X-Forwarded-Proto "^https$" HTTPS=on');
      expect(phpDirectives(plan)).not.toContain("SSLEngine on");
    }
    expect(buildStepIds(plan)).not.toContain(APACHE_SSL_PORTS_BUILD_STEP_ID);
  });

  test("a php plain listener on 443 moves native TLS to 8443", async () => {
    // Given / When
    const plan = await composePhp({ type: "php:8.3", via: "apache", certs: true, port: 443 });
    // Then
    expect(plan.endpoints).toContainEqual({
      _tag: "internal",
      port: 8443,
      protocol: "https",
      name: "web-https",
    });
    const directives = phpDirectives(plan);
    expect(directives).toContain("Listen 443");
    expect(directives).toContain("Listen 8443");
    expect(directives).toContain("<VirtualHost *:8443>");
    expect(directives).toContain("ServerName web.myapp.internal:443");
    expect(directives).not.toContain("ServerName web.myapp.internal:8443");
  });

  test("standalone apache declares both listeners and loads its shipped SSL modules", async () => {
    // Given / When
    const plan = await composeApache({ type: "apache", certs: true });
    // Then
    expect(plan.endpoints).toEqual([
      { _tag: "internal", port: 80, protocol: "http", name: "web", primary: true },
      { _tag: "internal", port: 443, protocol: "https", name: "web-https" },
    ]);
    const directives = apacheDirectives(plan);
    expect(directives).toContain("Listen 443");
    expect(directives.filter((directive) => directive === "<VirtualHost *:443>")).toHaveLength(1);
    expect(directives).toContain("SSLEngine on");
    expect(directives).not.toContain('SetEnvIf X-Forwarded-Proto "^https$" HTTPS=on');
    const script = buildStepScript(plan, APACHE_SSL_MODULE_BUILD_STEP_ID);
    expect(script).toContain("mod_ssl.so");
    expect(script).toContain("mod_socache_shmcb.so");
    expect(script).toContain("httpd-ssl.conf");
  });

  test("standalone apache keeps native TLS with additive build steps", async () => {
    // Given: additive image steps are not a replacement build.
    const plan = await composeApache({
      type: "apache",
      certs: true,
      build: { artifact: ["echo extra > /tmp/extra"] },
    });
    // Then
    expect(plan.endpoints).toContainEqual({
      _tag: "internal",
      port: 443,
      protocol: "https",
      name: "web-https",
    });
    expect(apacheDirectives(plan)).toContain("SSLEngine on");
  });

  test("standalone apache keeps its original launcher when no certificate is generated", async () => {
    // Given / When
    const plan = await composeApache({ type: "apache" });
    // Then
    expect(plan.endpoints).toEqual([
      { _tag: "internal", port: 80, protocol: "http", name: "web", primary: true },
    ]);
    expect(apacheDirectives(plan)).not.toContain("SSLEngine on");
    expect(buildStepIds(plan)).not.toContain(APACHE_SSL_MODULE_BUILD_STEP_ID);
  });
});

const resolveService = (serviceType: ServiceType, raw: unknown) =>
  Effect.runSync(
    serviceType.resolve({
      name: "web",
      service: decodeService(raw),
      appRoot: APP_ROOT,
      metadata,
    }),
  );

describe("generated Apache certificate association", () => {
  test.each([
    { label: "php via apache", serviceType: php83ServiceType, raw: { type: "php:8.3", via: "apache" } },
    { label: "standalone apache", serviceType: apacheServiceType, raw: { type: "apache" } },
  ] as const)(
    "$label reports its generated listener before a certificate is requested",
    ({ serviceType, raw }) => {
      // Given / When
      const resolution = resolveService(serviceType, raw);
      // Then: the association is a capability, not a demand.
      expect(resolution.generatedCertificateEndpoint).toEqual({ port: 443 });
      expect(resolution.normalizedConfig.certs).toBeUndefined();
    },
  );

  test.each([
    {
      label: "php via apache",
      serviceType: php83ServiceType,
      raw: { type: "php:8.3", via: "apache", certs: true, user: "www-data" },
      compose: composePhp,
    },
    {
      label: "standalone apache",
      serviceType: apacheServiceType,
      raw: { type: "apache", certs: true, user: "www-data" },
      compose: composeApache,
    },
  ] as const)(
    "$label keeps the non-root association but no TLS listener",
    async ({ serviceType, raw, compose }) => {
      // Given: a root-only key and an explicitly non-root parent.
      const resolution = resolveService(serviceType, raw);
      const plan = await compose(raw);
      // Then: the association records the opt-out; nothing serves native TLS.
      expect(resolution.generatedCertificateEndpoint).toEqual({ port: 443 });
      expect(plan.endpoints?.some((endpoint) => endpoint.protocol === "https")).toBe(false);
      expect(buildStepIds(plan)).not.toContain(APACHE_SSL_MODULE_BUILD_STEP_ID);
      expect(buildStepIds(plan)).not.toContain(APACHE_SSL_PORTS_BUILD_STEP_ID);
    },
  );
});
