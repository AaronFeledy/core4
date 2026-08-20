import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { LandofileShape, PortablePath, ServiceName, TomcatServiceConfig } from "@lando/sdk/schema";
import type { ServiceType } from "@lando/sdk/services";

import {
  TOMCAT_FEATURE_ID,
  tomcat9ServiceType,
  tomcat10ServiceType,
  tomcat11ServiceType,
  tomcatServiceFeature,
  tomcatServiceType,
} from "../src/services/tomcat.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const metadata = {
  resolvedAt: "2026-08-19T00:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const featureOverrides = new Map([[TOMCAT_FEATURE_ID, tomcatServiceFeature]]);

const serviceConfig = (serviceDefinition: Record<string, unknown>) => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "myapp",
    services: { appserver: serviceDefinition },
  });
  const service = landofile.services?.[ServiceName.make("appserver")];
  if (service === undefined) throw new Error("appserver service missing");
  return service;
};

const planTomcatService = async (serviceType: ServiceType, serviceDefinition: Record<string, unknown>) =>
  composeServicePlan({
    serviceType,
    service: serviceConfig(serviceDefinition),
    appRoot: "/srv/apps/myapp",
    appName: "myapp",
    serviceName: "appserver",
    metadata,
    featureOverrides,
  });

const resolveTomcatService = (serviceType: ServiceType, serviceDefinition: Record<string, unknown>) =>
  Effect.runPromise(
    serviceType.resolve({
      name: "appserver",
      service: serviceConfig(serviceDefinition),
      appRoot: "/srv/apps/myapp",
      appName: "myapp",
      metadata,
    }),
  );

describe("tomcat ServiceType", () => {
  for (const [id, image, serviceType] of [
    ["tomcat:9", "tomcat:9-jre21", tomcat9ServiceType],
    ["tomcat:10", "tomcat:10-jre21", tomcat10ServiceType],
    ["tomcat:11", "tomcat:11-jre21", tomcat11ServiceType],
    ["tomcat", "tomcat:11-jre21", tomcatServiceType],
  ] as const) {
    describe(id, () => {
      test("plans the catalog defaults", async () => {
        const plan = await planTomcatService(serviceType, { type: id });

        expect(serviceType.base).toBe("lando");
        expect(serviceType.schema).toBe(TomcatServiceConfig);
        expect(plan.type).toBe("tomcat");
        expect(plan.artifact).toEqual({ kind: "ref", ref: image });
        expect(plan.endpoints).toEqual([
          { _tag: "internal", port: 8080, protocol: "http", name: "appserver" },
        ]);
        expect(String(plan.appMount?.target)).toBe("/usr/local/tomcat/webapps/ROOT");
        expect(plan.mounts.some((mount) => String(mount.target) === "/usr/local/tomcat/webapps/ROOT")).toBe(
          true,
        );
        expect(plan.healthcheck).toEqual({
          kind: "command",
          command: ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/8080"],
          intervalSeconds: 10,
          timeoutSeconds: 5,
          retries: 5,
          startPeriodSeconds: 20,
        });
      });

      test("resolves a default route and enables certs", async () => {
        const resolution = await resolveTomcatService(serviceType, { type: id });

        expect(resolution.normalizedConfig.routes).toEqual([
          { hostname: "appserver.myapp.lndo.site", endpoint: 8080 },
        ]);
        expect(resolution.normalizedConfig.certs).toBe(true);
        expect(resolution.normalizedConfig.webroot).toEqual(
          PortablePath.make("/usr/local/tomcat/webapps/ROOT"),
        );
      });

      test("authored routes replace the default route", async () => {
        const routes = [{ hostname: "java.example.test", scheme: "https", endpoint: 8080 }] as const;
        const resolution = await resolveTomcatService(serviceType, { type: id, routes });

        expect(resolution.normalizedConfig.routes).toEqual(routes);
      });

      test("preserves authored runtime overrides", async () => {
        const plan = await planTomcatService(serviceType, {
          type: id,
          image: "tomcat:custom",
          port: 8888,
          webroot: "/usr/local/tomcat/webapps/app",
          command: ["catalina.sh", "run"],
          user: "1000:1000",
        });

        expect(plan.artifact).toEqual({ kind: "ref", ref: "tomcat:custom" });
        expect(plan.endpoints).toEqual([
          { _tag: "internal", port: 8888, protocol: "http", name: "appserver" },
        ]);
        expect(String(plan.appMount?.target)).toBe("/usr/local/tomcat/webapps/app");
        expect(plan.command).toEqual(["catalina.sh", "run"]);
        expect(plan.user).toBe("1000:1000");
      });
    });
  }

  test("declares supported versions and artifacts", () => {
    expect(tomcatServiceType.versions).toEqual(["9", "10", "11"]);
    expect(tomcatServiceType.artifacts).toEqual({
      "9": "tomcat:9-jre21",
      "10": "tomcat:10-jre21",
      "11": "tomcat:11-jre21",
    });
  });
});
