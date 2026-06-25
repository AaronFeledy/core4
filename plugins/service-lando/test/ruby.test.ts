import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

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
  test("exposes 3.3 as the alpha supported ruby version", () => {
    expect([...SUPPORTED_RUBY_VERSIONS]).toEqual(["3.3"]);
  });

  test("exposes rails, none as the alpha supported frameworks", () => {
    expect([...SUPPORTED_RUBY_FRAMEWORKS]).toEqual(["rails", "none"]);
  });
});

describe("ruby:3.3 ServiceType", () => {
  test("plans a default Ruby 3.3 web service with framework=none defaults", async () => {
    const plan = await composeRubyPlan(ruby33ServiceType, { type: "ruby:3.3" });

    expect(plan.type).toBe("ruby:3.3");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "ruby:3.3-slim" });
    expect(plan.primary).toBe(true);
    expect(String(plan.workingDirectory)).toBe("/app");

    expect(String(plan.appMount?.source)).toBe(APP_ROOT);
    expect(String(plan.appMount?.target)).toBe("/app");
    expect(plan.appMount?.readOnly).toBe(false);

    expect(plan.mounts).toHaveLength(1);
    expect(plan.mounts[0]?.type).toBe("bind");
    expect(plan.mounts[0]?.source).toBe(APP_ROOT);
    expect(String(plan.mounts[0]?.target)).toBe("/app");

    expect(plan.endpoints).toEqual([{ port: 3000, protocol: "http", name: "web" }]);

    expect(plan.healthcheck).toEqual({
      kind: "command",
      command: ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/3000"],
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
      LANDO_SERVICE_TYPE: "ruby:3.3",
      LANDO_WEBROOT: "/app",
      BUNDLE_PATH: "vendor/bundle",
    });

    expect(plan.extensions["lando-service-ruby"]).toEqual({
      framework: "none",
      version: "3.3",
      defaultCommand: null,
      port: 3000,
      webroot: "/app",
    });
  });

  test("framework=rails sets port 3000, rails server default command preset, public/ webroot, and rails env", async () => {
    const plan = await composeRubyPlan(ruby33ServiceType, { type: "ruby:3.3", framework: "rails" });

    expect(plan.endpoints).toEqual([{ port: 3000, protocol: "http", name: "web" }]);
    expect(plan.healthcheck?.command).toEqual(["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/3000"]);
    expect(String(plan.workingDirectory)).toBe("/app");
    expect(plan.environment.RAILS_ENV).toBe("development");
    expect(plan.environment.RAILS_LOG_TO_STDOUT).toBe("true");
    expect(plan.environment.LANDO_WEBROOT).toBe("/app/public");

    expect(plan.extensions["lando-service-ruby"]).toEqual({
      framework: "rails",
      version: "3.3",
      defaultCommand: ["bundle", "exec", "rails", "server", "-b", "0.0.0.0", "-p", "3000"],
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

  test("user environment overrides framework defaults", async () => {
    const plan = await composeRubyPlan(ruby33ServiceType, {
      type: "ruby:3.3",
      framework: "rails",
      environment: { RAILS_ENV: "production", FOO: "bar" },
    });

    expect(plan.environment.RAILS_ENV).toBe("production");
    expect(plan.environment.FOO).toBe("bar");
    expect(plan.environment.LANDO_PROJECT).toBe("myapp");
  });

  test("propagates user image override and custom port", async () => {
    const plan = await composeRubyPlan(ruby33ServiceType, {
      type: "ruby:3.3",
      image: "registry.example.com/ruby:3.3-custom",
      port: 4000,
    });

    expect(plan.artifact).toEqual({ kind: "ref", ref: "registry.example.com/ruby:3.3-custom" });
    expect(plan.endpoints).toEqual([{ port: 4000, protocol: "http", name: "web" }]);
    expect(plan.healthcheck?.command).toEqual(["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/4000"]);
    expect(plan.extensions["lando-service-ruby"]).toMatchObject({ port: 4000 });
  });

  test("plan uses provider-neutral ServicePlan fields", async () => {
    const plan = await composeRubyPlan(ruby33ServiceType, { type: "ruby:3.3", framework: "rails" });

    expect(plan.extensions["lando-service-ruby"]).toBeDefined();
    expect(plan.artifact?.kind).toBe("ref");
    expect(plan.endpoints[0]?.protocol).toBe("http");
    expect(plan.healthcheck?.kind).toBe("command");
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
