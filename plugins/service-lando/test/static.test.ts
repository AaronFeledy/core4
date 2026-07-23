import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, type ServiceConfig, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import type { ServiceType } from "@lando/sdk/services";

import {
  STATIC_FEATURE_ID,
  staticCaddyServiceType,
  staticNginxServiceType,
  staticServiceFeature,
} from "../src/services/static.ts";

import { composeServicePlan } from "./support/compose-harness.ts";

const metadata = {
  resolvedAt: "2026-05-18T08:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const APP_ROOT = "/srv/apps/myapp";
const featureOverrides = new Map([[STATIC_FEATURE_ID, staticServiceFeature]]);

const decodeService = (raw: unknown, serviceName = "web"): ServiceConfig => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "myapp",
    services: { [serviceName]: raw },
  });
  const service = landofile.services?.[ServiceName.make(serviceName)];
  if (service === undefined) throw new Error(`${serviceName} service missing`);
  return service;
};

const composeStaticPlan = (
  raw: unknown,
  serviceType: ServiceType = staticNginxServiceType,
  serviceName = "web",
): Promise<ServicePlan> =>
  composeServicePlan({
    serviceType,
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

describe("static ServiceType", () => {
  test("default nginx-backed static server uses read-only app mount", async () => {
    const plan = await composeStaticPlan({ type: "static" });

    expect(plan.type).toBe("static:nginx");
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
      LANDO_SERVICE_TYPE: "static:nginx",
      LANDO_WEBROOT: "/app",
    });
    expect(String(plan.appMount?.source)).toBe(APP_ROOT);
    expect(String(plan.appMount?.target)).toBe("/app");
    expect(plan.appMount?.readOnly).toBe(true);
    expect(plan.mounts).toHaveLength(1);
    expect(plan.mounts[0]?.type).toBe("bind");
    expect(plan.mounts[0]?.source).toBe(APP_ROOT);
    expect(String(plan.mounts[0]?.target)).toBe("/app");
    expect(plan.mounts[0]?.readOnly).toBe(true);
    expect(plan.command).toEqual([
      "sh",
      "-c",
      [
        "cat > /etc/nginx/conf.d/default.conf <<'LANDO_STATIC_NGINX'",
        "server {",
        "  listen 80;",
        "  server_name _;",
        '  root "/app";',
        "  index index.html index.htm;",
        "  location / { try_files $uri $uri/ =404; }",
        "}",
        "LANDO_STATIC_NGINX",
        "exec nginx -g 'daemon off;'",
      ].join("\n"),
    ]);
    expect(plan.endpoints).toEqual([{ _tag: "internal", port: 80, protocol: "http", name: "web" }]);
    expect(plan.healthcheck?.kind).toBe("command");
    expect(plan.healthcheck?.command).toEqual(["sh", "-c", "nc -z 127.0.0.1 80"]);
    expect(plan.extensions["lando-service-static"]).toEqual({ server: "nginx" });
  });

  test("uses the authored service name in endpoint and lando env", async () => {
    const plan = await composeStaticPlan({ type: "static" }, staticNginxServiceType, "assets");

    expect(plan.primary).toBe(false);
    expect(plan.endpoints).toEqual([{ _tag: "internal", port: 80, protocol: "http", name: "assets" }]);
    expect(plan.environment).toMatchObject({
      LANDO_SERVICE_NAME: "assets",
      LANDO_SERVICE_TYPE: "static:nginx",
      LANDO_WEBROOT: "/app",
      LANDO_APP_ROOT: "/app",
      LANDO_PROJECT_MOUNT: "/app",
    });
  });

  test("caddy-backed static server picks caddy image", async () => {
    const plan = await composeStaticPlan({ type: "static:caddy" }, staticCaddyServiceType);

    expect(plan.type).toBe("static:caddy");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "caddy:2-alpine" });
    expect(plan.environment).toMatchObject({
      LANDO_SERVICE_TYPE: "static:caddy",
      LANDO_WEBROOT: "/app",
    });
    expect(plan.command).toEqual(["caddy", "file-server", "--listen", ":80", "--root", "/app"]);
    expect(plan.appMount?.readOnly).toBe(true);
    expect(plan.mounts[0]?.readOnly).toBe(true);
    expect(plan.endpoints).toEqual([{ _tag: "internal", port: 80, protocol: "http", name: "web" }]);
    expect(plan.healthcheck?.kind).toBe("command");
    expect(plan.healthcheck?.command).toEqual(["sh", "-c", "nc -z 127.0.0.1 80"]);
    expect(plan.extensions["lando-service-static"]).toEqual({ server: "caddy" });
  });

  test("root: dist sets LANDO_WEBROOT to /app/dist and records root in extensions", async () => {
    const plan = await composeStaticPlan({ type: "static", root: "dist" });

    expect(plan.environment.LANDO_WEBROOT).toBe("/app/dist");
    expect(plan.command).toEqual(["sh", "-c", expect.stringContaining('root "/app/dist";')]);
    expect(plan.appMount?.readOnly).toBe(true);
    expect(plan.endpoints[0]?.port).toBe(80);
    expect(plan.extensions["lando-service-static"]).toEqual({ server: "nginx", root: "dist" });
  });

  test("root: '/' or empty string falls back to /app without trailing slash", async () => {
    for (const rootValue of ["", "/", "///", "/dist/", "dist/"] as const) {
      const plan = await composeStaticPlan({ type: "static", root: rootValue });

      const expectedWebroot = rootValue.replace(/^\/+/, "").replace(/\/+$/, "") === "" ? "/app" : "/app/dist";
      expect(plan.environment.LANDO_WEBROOT).toBe(expectedWebroot);
      expect(plan.command).toEqual(["sh", "-c", expect.stringContaining(`root "${expectedWebroot}";`)]);
      expect(plan.extensions["lando-service-static"]).toEqual({ server: "nginx", root: rootValue });
    }
  });

  test("custom static commands are preserved", async () => {
    const plan = await composeStaticPlan({
      type: "static",
      command: ["custom-static-server"],
      entrypoint: ["/bin/sh", "-c"],
      dependsOn: ["database"],
    });

    expect(plan.command).toEqual(["custom-static-server"]);
    expect(plan.entrypoint).toEqual(["/bin/sh", "-c"]);
    expect(plan.dependsOn).toEqual([{ service: ServiceName.make("database"), condition: "started" }]);
  });

  test("rejects unsupported static server with remediation", async () => {
    await expectRejectsToThrow(
      composeStaticPlan({ type: "static:lighttpd" }),
      /Unsupported static server "lighttpd"\..*Set type to one of: static:nginx, static:caddy/,
    );
  });
});
