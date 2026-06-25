import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, type ServiceConfig, ServiceName, type ServicePlan } from "@lando/sdk/schema";

import { NGINX_FEATURE_ID, nginxServiceFeature, nginxServiceType } from "../src/services/nginx.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const metadata = {
  resolvedAt: "2026-05-18T08:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const APP_ROOT = "/srv/apps/myapp";
const featureOverrides = new Map([[NGINX_FEATURE_ID, nginxServiceFeature]]);

const decodeService = (raw: unknown, serviceName = "web"): ServiceConfig => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "myapp",
    services: { [serviceName]: raw },
  });
  const service = landofile.services?.[ServiceName.make(serviceName)];
  if (service === undefined) throw new Error(`${serviceName} service missing`);
  return service;
};

const composeNginxPlan = (raw: unknown, serviceName = "web"): Promise<ServicePlan> =>
  composeServicePlan({
    serviceType: nginxServiceType,
    service: decodeService(raw, serviceName),
    appRoot: APP_ROOT,
    appName: "myapp",
    serviceName,
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

describe("nginx ServiceType", () => {
  test("plans a default nginx web service with app bind mount", async () => {
    const plan = await composeNginxPlan({ type: "nginx" });

    expect(plan.type).toBe("nginx");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "nginx:1.26-alpine" });
    expect(plan.environment).toMatchObject({
      LANDO: "ON",
      LANDO_APP_NAME: "myapp",
      LANDO_APP_KIND: "user",
      LANDO_APP_ROOT: "/app",
      LANDO_PROJECT: "myapp",
      LANDO_PROJECT_MOUNT: "/app",
      LANDO_SERVICE_API: "4",
      LANDO_SERVICE_NAME: "web",
      LANDO_SERVICE_TYPE: "nginx",
      LANDO_WEBROOT: "/app",
    });
    expect(plan.environment.APACHE_DOCUMENT_ROOT).toBeUndefined();
    expect(String(plan.appMount?.source)).toBe(APP_ROOT);
    expect(String(plan.appMount?.target)).toBe("/app");
    expect(plan.appMount?.readOnly).toBe(false);
    expect(plan.mounts).toHaveLength(1);
    expect(plan.mounts[0]?.type).toBe("bind");
    expect(plan.mounts[0]?.source).toBe(APP_ROOT);
    expect(String(plan.mounts[0]?.target)).toBe("/app");
    expect(plan.mounts[0]?.readOnly).toBe(false);
    expect(plan.endpoints).toEqual([{ port: 80, protocol: "http", name: "web" }]);
    expect(plan.healthcheck?.kind).toBe("command");
    expect(plan.healthcheck?.command).toEqual(["sh", "-c", "nc -z 127.0.0.1 80"]);
  });

  test("uses the authored service name in endpoint and lando env", async () => {
    const plan = await composeNginxPlan({ type: "nginx" }, "proxy");

    expect(plan.primary).toBe(false);
    expect(plan.endpoints).toEqual([{ port: 80, protocol: "http", name: "proxy" }]);
    expect(plan.environment).toMatchObject({
      LANDO_SERVICE_NAME: "proxy",
      LANDO_SERVICE_TYPE: "nginx",
      LANDO_WEBROOT: "/app",
      LANDO_APP_ROOT: "/app",
      LANDO_PROJECT_MOUNT: "/app",
    });
  });

  test("rejects LANDO_* env overrides", async () => {
    await expectRejectsToThrow(
      composeNginxPlan({ type: "nginx", environment: { LANDO_APP_NAME: "fake" } }),
      /reserved LANDO_\* keys.*LANDO_APP_NAME/,
    );
  });
});
