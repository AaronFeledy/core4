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
    expect(plan.environment).toMatchObject({
      APACHE_DOCUMENT_ROOT: "/app",
      LANDO_APP_ROOT: "/app",
      LANDO_PROJECT_MOUNT: "/app",
      LANDO_SERVICE_NAME: "backend",
      LANDO_SERVICE_TYPE: "apache",
      LANDO_WEBROOT: "/app",
    });
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
  });
});
