import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { LandofileShape, type ServiceConfig, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import type { ServiceType } from "@lando/sdk/services";

import {
  RUBY_FEATURE_ID,
  SUPPORTED_RUBY_FRAMEWORKS,
  SUPPORTED_RUBY_VERSIONS,
  ruby33ServiceType,
  rubyServiceFeature,
} from "../src/services/ruby.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const metadata = {
  resolvedAt: "2026-05-18T00:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const APP_ROOT = "/srv/apps/myapp";
const featureOverrides = new Map([[RUBY_FEATURE_ID, rubyServiceFeature]]);

const decodeService = (raw: unknown): ServiceConfig => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "myapp",
    services: { web: raw },
  });
  const service = landofile.services?.[ServiceName.make("web")];
  if (service === undefined) throw new Error("web service missing");
  return service;
};

const composeRubyPlan = (serviceType: ServiceType, raw: unknown, appRoot = APP_ROOT): Promise<ServicePlan> =>
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

describe("ruby ServiceType — supported versions and frameworks", () => {
  test("exposes 3.3 as the supported ruby version", () => {
    expect([...SUPPORTED_RUBY_VERSIONS]).toEqual(["3.3"]);
  });

  test("exposes rails, none as the supported frameworks", () => {
    expect([...SUPPORTED_RUBY_FRAMEWORKS]).toEqual(["rails", "none"]);
  });
});

describe("ruby:3.3 ServiceType", () => {
  test("omits implicit Rails context when appMount is false", async () => {
    // Given: a Rails service that does not use app code.
    const definition = {
      type: "ruby:3.3",
      framework: "rails",
      appMount: false,
    };
    // When: the preset is resolved and composed.
    const plan = await composeRubyPlan(ruby33ServiceType, definition);
    // Then: the image supplies cwd and there is no app-relative webroot.
    expect(plan.environment.LANDO_WEBROOT).toBeUndefined();
    expect(plan.workingDirectory).toBeUndefined();
    expect(plan.appMount).toBeUndefined();
    expect(plan.extensions["lando-service-ruby"]).not.toHaveProperty("webroot");
  });
  test("plans a default Ruby 3.3 web service with framework=none defaults", async () => {
    const plan = await composeRubyPlan(ruby33ServiceType, { type: "ruby:3.3" });

    expect(plan.type).toBe("ruby:3.3");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "ruby:3.3-slim" });
    expect(plan.primary).toBe(true);
    expect(String(plan.workingDirectory)).toBe("/app");

    expect(String(plan.appMount?.source)).toBe(APP_ROOT);
    expect(String(plan.appMount?.target)).toBe("/app");
    expect(plan.appMount?.readOnly).toBe(false);

    expect(plan.mounts).toEqual([]);

    expect(plan.endpoints).toEqual([{ _tag: "internal", port: 3000, protocol: "http", name: "web" }]);

    expect(plan.healthcheck).toBeUndefined();

    expect(plan.environment).toMatchObject({
      LANDO: "ON",
      LANDO_APP_NAME: "myapp",
      LANDO_APP_KIND: "user",
      LANDO_APP_ROOT: "/app",
      LANDO_PROJECT: "myapp",
      LANDO_PROJECT_MOUNT: "/app",
      LANDO_SERVICE_API: "4",
      LANDO_SERVICE_NAME: "web",
      LANDO_SERVICE_TYPE: "ruby:3.3",
      LANDO_WEBROOT: "/app",
      BUNDLE_PATH: "vendor/bundle",
    });

    expect(plan.extensions["lando-service-ruby"]).toEqual({
      framework: "none",
      version: "3.3",
      port: 3000,
      webroot: "/app",
    });
  });

  test("framework=rails sets port, public context, and Rails env while keeping the service alive", async () => {
    const plan = await composeRubyPlan(ruby33ServiceType, { type: "ruby:3.3", framework: "rails" });

    expect(plan.endpoints).toEqual([{ _tag: "internal", port: 3000, protocol: "http", name: "web" }]);
    expect(plan.healthcheck).toBeUndefined();
    expect(String(plan.workingDirectory)).toBe("/app");
    expect(plan.environment.RAILS_ENV).toBe("development");
    expect(plan.environment.RAILS_LOG_TO_STDOUT).toBe("true");
    expect(plan.environment.LANDO_WEBROOT).toBe("/app/public");
    expect(plan.command).toEqual(["sh", "-c", "tail -f /dev/null"]);

    expect(plan.extensions["lando-service-ruby"]).toEqual({
      framework: "rails",
      version: "3.3",
      port: 3000,
      webroot: "/app/public",
    });
  });

  test("derives appName from appRoot basename when no explicit appName is provided", async () => {
    const plan = await composeServicePlan({
      serviceType: ruby33ServiceType,
      service: decodeService({ type: "ruby:3.3" }),
      appRoot: "/srv/apps/anotherapp",
      serviceName: "web",
      metadata,
      featureOverrides,
    });

    expect(plan.environment.LANDO_APP_NAME).toBe("anotherapp");
    expect(plan.environment.LANDO_PROJECT).toBe("anotherapp");
  });

  test.each([
    ["rails", "frontend/public", undefined, "/app/frontend/public"],
    ["rails", "./frontend/public/", { target: "/site/" }, "/site/frontend/public"],
    ["rails", "/srv/www/./public/", { target: "/site" }, "/srv/www/public"],
    ["none", "frontend/public", undefined, "/app/frontend/public"],
  ] as const)(
    "framework=%s resolves authored webroot %s with mount %j",
    async (framework, webroot, appMount, resolved) => {
      // Given: an authored webroot distinct from the framework default.
      const definition = {
        type: "ruby:3.3",
        framework,
        webroot,
        ...(appMount === undefined ? {} : { appMount }),
      };
      // When: the service is resolved and composed through its real features.
      const resolution = Effect.runSync(
        ruby33ServiceType.resolve({
          name: "web",
          service: decodeService(definition),
          appRoot: APP_ROOT,
          metadata,
        }),
      );
      const plan = await composeRubyPlan(ruby33ServiceType, definition);
      // Then: env and extension use the resolved path without rewriting authored config or cwd.
      expect(String(resolution.normalizedConfig.webroot)).toBe(webroot);
      expect(plan.environment.LANDO_WEBROOT).toBe(resolved);
      expect(plan.extensions["lando-service-ruby"]).toMatchObject({ webroot: resolved });
      expect(String(plan.workingDirectory)).toBe(appMount === undefined ? "/app" : "/site");
    },
  );

  test.each(["../outside", "frontend/../..", "$host", "web root", ""])(
    "rejects authored Rails webroot %s when app code is mounted",
    async (webroot) => {
      // Given: a webroot that escapes the mount or contains unsafe characters.
      const definition = { type: "ruby:3.3", framework: "rails", webroot };
      // When / Then: planning rejects the authored value rather than silently using public/.
      await expect(composeRubyPlan(ruby33ServiceType, definition)).rejects.toThrow(/Ruby webroot/);
    },
  );

  test("user environment overrides framework defaults", async () => {
    const plan = await composeRubyPlan(ruby33ServiceType, {
      type: "ruby:3.3",
      framework: "rails",
      webroot: "frontend/public",
      workingDirectory: "/work",
      environment: { RAILS_ENV: "production", FOO: "bar" },
    });

    expect(plan.environment.RAILS_ENV).toBe("production");
    expect(plan.environment.FOO).toBe("bar");
    expect(plan.environment.LANDO_PROJECT).toBe("myapp");
    expect(String(plan.workingDirectory)).toBe("/work");
  });

  test("propagates user image override and custom port", async () => {
    const plan = await composeRubyPlan(ruby33ServiceType, {
      type: "ruby:3.3",
      image: "registry.example.com/ruby:3.3-custom",
      port: 4000,
    });

    expect(plan.artifact).toEqual({ kind: "ref", ref: "registry.example.com/ruby:3.3-custom" });
    expect(plan.endpoints).toEqual([{ _tag: "internal", port: 4000, protocol: "http", name: "web" }]);
    expect(plan.healthcheck).toBeUndefined();
    expect(plan.extensions["lando-service-ruby"]).toMatchObject({ port: 4000 });
  });

  test("plan uses provider-neutral ServicePlan fields", async () => {
    const plan = await composeRubyPlan(ruby33ServiceType, { type: "ruby:3.3", framework: "rails" });

    expect(plan.extensions["lando-service-ruby"]).toBeDefined();
    expect(plan.artifact?.kind).toBe("ref");
    expect(plan.endpoints[0]?.protocol).toBe("http");
    expect(plan.healthcheck).toBeUndefined();
    expect(Object.keys(plan)).not.toContain("providers");
    expect(Object.keys(plan)).not.toContain("providerInfo");
  });

  test("rejects unsupported framework values with remediation", async () => {
    await expectRejectsToThrow(
      composeRubyPlan(ruby33ServiceType, { type: "ruby:3.3", framework: "sinatra" }),
      /Unsupported Ruby framework "sinatra"\./,
    );

    await expectRejectsToThrow(
      composeRubyPlan(ruby33ServiceType, { type: "ruby:3.3", framework: "sinatra" }),
      /Set framework to one of: rails, none/,
    );
  });

  test("rejects unsupported Ruby versions with remediation", async () => {
    await expectRejectsToThrow(
      composeRubyPlan(ruby33ServiceType, { type: "ruby:3.2" }),
      /Unsupported Ruby version "3.2"\./,
    );

    await expectRejectsToThrow(
      composeRubyPlan(ruby33ServiceType, { type: "ruby:3.2" }),
      /Set type to one of: ruby:3.3/,
    );
  });

  test("rejects user environment that targets reserved LANDO_* keys", async () => {
    await expectRejectsToThrow(
      composeRubyPlan(ruby33ServiceType, {
        type: "ruby:3.3",
        environment: { LANDO_PROJECT: "evil", FOO: "bar" },
      }),
      /reserved LANDO_\* keys.*LANDO_PROJECT/,
    );
  });
});
