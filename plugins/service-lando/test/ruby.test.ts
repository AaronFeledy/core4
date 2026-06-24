import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, type ServiceConfig, ServiceName } from "@lando/sdk/schema";

import {
  SUPPORTED_RUBY_FRAMEWORKS,
  SUPPORTED_RUBY_VERSIONS,
  ruby33ServiceType,
} from "../src/services/ruby.ts";

const metadata = {
  resolvedAt: "2026-05-18T00:00:00Z",
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

describe("ruby ServiceType — supported versions and frameworks", () => {
  test("exposes 3.3 as the alpha supported ruby version", () => {
    expect([...SUPPORTED_RUBY_VERSIONS]).toEqual(["3.3"]);
  });

  test("exposes rails, none as the alpha supported frameworks", () => {
    expect([...SUPPORTED_RUBY_FRAMEWORKS]).toEqual(["rails", "none"]);
  });
});

describe("ruby:3.3 ServiceType", () => {
  test("plans a default Ruby 3.3 web service with framework=none defaults", () => {
    const service = decodeService({ type: "ruby:3.3" });
    const plan = ruby33ServiceType.__legacyToServicePlan({
      name: "web",
      service,
      appRoot: APP_ROOT,
      appName: "myapp",
      metadata,
    });

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

    expect(plan.environment.LANDO).toBe("ON");
    expect(plan.environment.LANDO_APP_NAME).toBe("myapp");
    expect(plan.environment.LANDO_APP_KIND).toBe("user");
    expect(plan.environment.LANDO_APP_ROOT).toBe("/app");
    expect(plan.environment.LANDO_PROJECT).toBe("myapp");
    expect(plan.environment.LANDO_PROJECT_MOUNT).toBe("/app");
    expect(plan.environment.LANDO_SERVICE_API).toBe("4");
    expect(plan.environment.LANDO_SERVICE_NAME).toBe("web");
    expect(plan.environment.LANDO_SERVICE_TYPE).toBe("ruby:3.3");

    expect(plan.environment.BUNDLE_PATH).toBe("vendor/bundle");

    expect(plan.extensions["lando-service-ruby"]).toEqual({
      framework: "none",
      version: "3.3",
      defaultCommand: null,
      port: 3000,
      webroot: "/app",
    });
  });

  test("framework=rails sets port 3000, rails server default command preset, public/ webroot, and rails env", () => {
    const service = decodeService({ type: "ruby:3.3", framework: "rails" });
    const plan = ruby33ServiceType.__legacyToServicePlan({
      name: "web",
      service,
      appRoot: APP_ROOT,
      appName: "myapp",
      metadata,
    });

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

  test("derives appName from appRoot basename when no explicit appName is provided", () => {
    const service = decodeService({ type: "ruby:3.3" });
    const plan = ruby33ServiceType.__legacyToServicePlan({
      name: "web",
      service,
      appRoot: "/srv/apps/anotherapp",
      metadata,
    });
    expect(plan.environment.LANDO_APP_NAME).toBe("anotherapp");
    expect(plan.environment.LANDO_PROJECT).toBe("anotherapp");
  });

  test("user environment overrides framework defaults but cannot override LANDO_*", () => {
    const service = decodeService({
      type: "ruby:3.3",
      framework: "rails",
      environment: { RAILS_ENV: "production", FOO: "bar" },
    });
    const plan = ruby33ServiceType.__legacyToServicePlan({
      name: "web",
      service,
      appRoot: APP_ROOT,
      appName: "myapp",
      metadata,
    });

    expect(plan.environment.RAILS_ENV).toBe("production");
    expect(plan.environment.FOO).toBe("bar");
    expect(plan.environment.LANDO_PROJECT).toBe("myapp");
  });

  test("propagates user image override and custom port", () => {
    const service = decodeService({
      type: "ruby:3.3",
      image: "registry.example.com/ruby:3.3-custom",
      port: 4000,
    });
    const plan = ruby33ServiceType.__legacyToServicePlan({
      name: "web",
      service,
      appRoot: APP_ROOT,
      appName: "myapp",
      metadata,
    });

    expect(plan.artifact).toEqual({ kind: "ref", ref: "registry.example.com/ruby:3.3-custom" });
    expect(plan.endpoints).toEqual([{ port: 4000, protocol: "http", name: "web" }]);
    expect(plan.healthcheck?.command).toEqual(["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/4000"]);
    expect(plan.extensions["lando-service-ruby"]).toMatchObject({ port: 4000 });
  });

  test("plan uses provider-neutral ServicePlan fields", () => {
    const service = decodeService({ type: "ruby:3.3", framework: "rails" });
    const plan = ruby33ServiceType.__legacyToServicePlan({
      name: "web",
      service,
      appRoot: APP_ROOT,
      appName: "myapp",
      metadata,
    });

    expect(plan.extensions["lando-service-ruby"]).toBeDefined();
    expect(plan.artifact.kind).toBe("ref");
    expect(plan.endpoints[0]?.protocol).toBe("http");
    expect(plan.healthcheck?.kind).toBe("command");
    expect(Object.keys(plan)).not.toContain("providers");
    expect(Object.keys(plan)).not.toContain("providerInfo");
  });

  test("rejects unsupported framework values with remediation", () => {
    const service = decodeService({ type: "ruby:3.3", framework: "sinatra" });
    expect(() =>
      ruby33ServiceType.__legacyToServicePlan({
        name: "web",
        service,
        appRoot: APP_ROOT,
        appName: "myapp",
        metadata,
      }),
    ).toThrow(/Unsupported Ruby framework "sinatra"\./);

    expect(() =>
      ruby33ServiceType.__legacyToServicePlan({
        name: "web",
        service,
        appRoot: APP_ROOT,
        appName: "myapp",
        metadata,
      }),
    ).toThrow(/Set framework to one of: rails, none/);
  });

  test("rejects unsupported Ruby versions with remediation", () => {
    const service = decodeService({ type: "ruby:3.2" });
    expect(() =>
      ruby33ServiceType.__legacyToServicePlan({
        name: "web",
        service,
        appRoot: APP_ROOT,
        appName: "myapp",
        metadata,
      }),
    ).toThrow(/Unsupported Ruby version "3.2"\./);

    expect(() =>
      ruby33ServiceType.__legacyToServicePlan({
        name: "web",
        service,
        appRoot: APP_ROOT,
        appName: "myapp",
        metadata,
      }),
    ).toThrow(/Set type to one of: ruby:3.3/);
  });

  test("rejects user environment that targets reserved LANDO_* keys", () => {
    const service = decodeService({
      type: "ruby:3.3",
      environment: { LANDO_PROJECT: "evil", FOO: "bar" },
    });
    expect(() =>
      ruby33ServiceType.__legacyToServicePlan({
        name: "web",
        service,
        appRoot: APP_ROOT,
        appName: "myapp",
        metadata,
      }),
    ).toThrow(/reserved LANDO_\* keys.*LANDO_PROJECT/);
  });
});
