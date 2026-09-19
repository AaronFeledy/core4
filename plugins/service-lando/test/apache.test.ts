import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, type ServiceConfig, ServiceName, type ServicePlan } from "@lando/sdk/schema";

import { APACHE_FEATURE_ID, apacheServiceFeature, apacheServiceType } from "../src/services/apache.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const metadata = {
  resolvedAt: "2026-05-18T08:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const APP_ROOT = "/srv/apps/myapp";
const featureOverrides = new Map([[APACHE_FEATURE_ID, apacheServiceFeature]]);

const decodeService = (raw: unknown): ServiceConfig => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "myapp",
    services: { web: raw },
  });
  const service = landofile.services?.[ServiceName.make("web")];
  if (service === undefined) throw new Error("web service missing");
  return service;
};

/**
 * Reads the generated launcher as argv and returns the Apache directives it
 * carries, failing on any `-c` flag that lost its directive. Asserting on
 * directives instead of one serialized string keeps this a behavioral proof
 * rather than a snapshot of the command's spelling.
 */
const apacheDirectives = (command: ServicePlan["command"]): ReadonlyArray<string> => {
  if (!Array.isArray(command)) throw new Error(`Apache command must be argv, got ${typeof command}.`);
  const [launcher, ...rest] = command as ReadonlyArray<string>;
  if (launcher !== "httpd-foreground") {
    throw new Error(`Apache launcher must be httpd-foreground, got ${String(launcher)}.`);
  }
  const directives: Array<string> = [];
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const directive = rest[index + 1];
    if (flag !== "-c") throw new Error(`Expected a -c flag at argv position ${index}, got ${String(flag)}.`);
    if (directive === undefined) throw new Error(`The -c flag at argv position ${index} has no directive.`);
    directives.push(directive);
  }
  return directives;
};

const composeApachePlan = (raw: unknown, serviceName = "web"): Promise<ServicePlan> =>
  composeServicePlan({
    serviceType: apacheServiceType,
    service: decodeService(raw),
    appRoot: APP_ROOT,
    appName: "myapp",
    serviceName,
    metadata,
    featureOverrides,
  });

describe("apache ServiceType", () => {
  test("plans a default Apache web service with APACHE_DOCUMENT_ROOT env", async () => {
    const plan = await composeApachePlan({ type: "apache" });

    expect(plan.type).toBe("apache");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "httpd:2.4-alpine" });
    expect(String(plan.workingDirectory)).toBe("/app");
    expect(plan.environment).toMatchObject({
      APACHE_DOCUMENT_ROOT: "/app",
      LANDO_APP_ROOT: "/app",
      LANDO_PROJECT_MOUNT: "/app",
      LANDO_SERVICE_NAME: "web",
      LANDO_SERVICE_TYPE: "apache",
      LANDO_WEBROOT: "/app",
    });

    expect(String(plan.appMount?.source)).toBe(APP_ROOT);
    expect(String(plan.appMount?.target)).toBe("/app");
    expect(plan.appMount?.readOnly).toBe(false);
    expect(plan.appMount?.realization).toBe("passthrough");

    expect(plan.mounts).toHaveLength(1);
    expect(plan.mounts[0]).toMatchObject({
      type: "bind",
      source: APP_ROOT,
      readOnly: false,
      realization: "passthrough",
    });
    expect(String(plan.mounts[0]?.target)).toBe("/app");

    expect(plan.endpoints).toEqual([{ _tag: "internal", port: 80, protocol: "http", name: "web" }]);
    expect(plan.healthcheck).toEqual({
      kind: "command",
      command: ["sh", "-c", "nc -z 127.0.0.1 80"],
      intervalSeconds: 10,
      timeoutSeconds: 5,
      retries: 5,
      startPeriodSeconds: 10,
    });
  });

  test("uses serviceName for endpoints and LANDO env", async () => {
    const plan = await composeApachePlan({ type: "apache", port: 8080 }, "backend");

    expect(plan.endpoints).toEqual([{ _tag: "internal", port: 8080, protocol: "http", name: "backend" }]);
    expect(plan.healthcheck?.kind).toBe("command");
    expect(plan.healthcheck?.command).toEqual(["sh", "-c", "nc -z 127.0.0.1 8080"]);
    expect(apacheDirectives(plan.command).some((directive) => directive.startsWith("Listen "))).toBe(false);
    expect(plan.environment).toMatchObject({
      APACHE_DOCUMENT_ROOT: "/app",
      LANDO_APP_ROOT: "/app",
      LANDO_PROJECT_MOUNT: "/app",
      LANDO_SERVICE_NAME: "backend",
      LANDO_SERVICE_TYPE: "apache",
      LANDO_WEBROOT: "/app",
    });
  });

  test("serves an authored webroot through Apache config and LANDO env", async () => {
    // Given / When
    const plan = await composeApachePlan({ type: "apache", webroot: "/app/public files/$site" });

    // Then
    expect(plan.environment).toMatchObject({
      APACHE_DOCUMENT_ROOT: "/app/public files/$site",
      LANDO_WEBROOT: "/app/public files/$site",
    });
    const directives = apacheDirectives(plan.command);
    expect(directives).toContain('DocumentRoot "/app/public files/$site"');
    expect(directives).toContain('<Directory "/app/public files/$site">');
  });

  test("rejects line breaks in an authored webroot before generating Apache config", async () => {
    // Given / When / Then
    expect(composeApachePlan({ type: "apache", webroot: "/app/public\nRequire all denied" })).rejects.toThrow(
      /Apache webroot must not contain line breaks/,
    );
  });

  test("user environment overrides Apache feature defaults after lando.env applies", async () => {
    const plan = await composeApachePlan({
      type: "apache",
      environment: { APACHE_DOCUMENT_ROOT: "/app/custom", FOO: "bar" },
    });

    expect(plan.environment).toMatchObject({
      APACHE_DOCUMENT_ROOT: "/app/custom",
      FOO: "bar",
      LANDO_APP_ROOT: "/app",
      LANDO_PROJECT_MOUNT: "/app",
      LANDO_WEBROOT: "/app",
    });
    expect(apacheDirectives(plan.command)).toContain('DocumentRoot "/app/custom"');
  });

  test("preserves authored command and entrypoint instead of installing the generated launcher", async () => {
    // Given / When
    const plan = await composeApachePlan({
      type: "apache",
      webroot: "/app/public",
      command: ["httpd", "-DFOREGROUND"],
      entrypoint: ["custom-entrypoint"],
    });

    // Then
    expect(plan.command).toEqual(["httpd", "-DFOREGROUND"]);
    expect(plan.entrypoint).toEqual(["custom-entrypoint"]);
  });

  test("starts a non-root Apache service without writing config from PID 1", async () => {
    // Given / When
    const plan = await composeApachePlan({ type: "apache", user: "www-data", webroot: "/app/public" });

    // Then: the planned user reaches the container and the launcher it runs needs
    // nothing that only root can do.
    expect(plan.user).toBe("www-data");
    const directives = apacheDirectives(plan.command);
    expect(directives).toContain('DocumentRoot "/app/public"');
    expect(directives).toContain('PidFile "/tmp/lando-httpd.pid"');

    const open = directives.indexOf('<Directory "/app/public">');
    const close = directives.indexOf("</Directory>");
    expect(open).toBeGreaterThanOrEqual(0);
    expect(close).toBeGreaterThan(open);
    expect(directives.slice(open + 1, close)).toEqual([
      "Options -Indexes +FollowSymLinks",
      "AllowOverride None",
      "Require all granted",
    ]);

    const argv = plan.command as ReadonlyArray<string>;
    expect(argv).not.toContain("sh");
    expect(argv.filter((token) => token.includes("/usr/local/apache2"))).toEqual([]);
    expect(argv.join("\n")).not.toMatch(/>\s*\//u);
  });

  test("declares the webroot once per start instead of accumulating config", async () => {
    // Given / When
    const plan = await composeApachePlan({ type: "apache", webroot: "/app/public" });
    const directives = apacheDirectives(plan.command);

    // Then: the launcher declares the webroot inline, so repeated starts cannot
    // append to a config file the previous start left behind.
    expect(directives.filter((directive) => directive.startsWith("DocumentRoot "))).toEqual([
      'DocumentRoot "/app/public"',
    ]);
    expect(directives.filter((directive) => directive.startsWith("<Directory "))).toEqual([
      '<Directory "/app/public">',
    ]);
    expect(directives.filter((directive) => directive === "</Directory>")).toHaveLength(1);
    expect(directives.join("\n")).not.toContain("Include");
  });
});
