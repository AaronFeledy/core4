import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { composeService } from "@lando/engine/services/feature";
import { LandofileShape, ProviderId, ServiceName, TomcatServiceConfig } from "@lando/sdk/schema";
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
const BuildSteps = Schema.Struct({
  buildSteps: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      phase: Schema.String,
      user: Schema.optionalKey(Schema.String),
      command: Schema.Unknown,
    }),
  ),
});

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
  test.each([
    { webroot: 42, ownsImageConfig: true },
    { webroot: "/app", ownsImageConfig: "true" },
    { webroot: "/app", ownsImageConfig: true, unexpected: true },
  ])("rejects malformed feature config %j before applying it", async (config) => {
    // Given: feature config that violates the declared Tomcat schema.
    // When: it crosses the engine's composition boundary.
    const result = await Effect.runPromise(
      Effect.result(
        composeService({
          base: {
            name: ServiceName.make("appserver"),
            type: "tomcat",
            provider: ProviderId.make("lando"),
            primary: true,
            defaultFeatures: [],
          },
          baseKind: "lando",
          appRoot: "/srv/apps/myapp",
          normalizedConfig: {},
          features: [{ id: TOMCAT_FEATURE_ID, definition: tomcatServiceFeature, config }],
        }),
      ),
    );
    // Then: schema validation rejects it before the feature can configure the image.
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "ServiceFeatureError",
        feature: TOMCAT_FEATURE_ID,
        message: expect.stringContaining("Invalid service feature config"),
      },
    });
  });

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
        expect(String(plan.appMount?.target)).toBe("/app");
        expect(plan.mounts).toEqual([]);
        expect(plan.environment.LANDO_APP_ROOT).toBe("/app");
        expect(plan.environment.LANDO_PROJECT_MOUNT).toBe("/app");
        expect(plan.environment.LANDO_WEBROOT).toBe("/app");
        expect(String(plan.workingDirectory)).toBe("/app");
        expect(plan.healthcheck).toEqual({
          kind: "command",
          command: ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/8080"],
          intervalSeconds: 10,
          timeoutSeconds: 5,
          retries: 5,
          startPeriodSeconds: 20,
        });
      });

      test("resolves the default webroot and enables certs", async () => {
        const resolution = await resolveTomcatService(serviceType, { type: id });

        expect(resolution.normalizedConfig.certs).toBe(true);
        expect(resolution.normalizedConfig.webroot).toBeUndefined();
      });

      test("preserves authored routes", async () => {
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
        expect(String(plan.appMount?.target)).toBe("/app");
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

  test.each([
    [{}, "/app"],
    [{ webroot: "target/myapp" }, "/app/target/myapp"],
    [{ appMount: { target: "/site" } }, "/site"],
    [{ webroot: "/srv/www" }, "/srv/www"],
    [{ command: ["catalina.sh", "jpda", "run"] }, "/app"],
    [{ appMount: false, webroot: "/srv/www" }, "/srv/www"],
  ])("writes the ROOT context for %j", async (definition, docBase) => {
    // Given: a Tomcat service using the catalog image.
    // When: its runtime plan is composed.
    const plan = await planTomcatService(tomcatServiceType, { type: "tomcat", ...definition });
    // Then: the build configures ROOT without replacing the server configuration or command.
    const features = Schema.decodeUnknownSync(BuildSteps)(plan.extensions["@lando/core/service-features"]);
    const step = features.buildSteps.find(({ id }) => id === "service-lando.tomcat:root-context");
    const command = Schema.decodeUnknownSync(Schema.Array(Schema.String))(step?.command).join(" ");
    expect(step).toMatchObject({ phase: "build", user: "root" });
    expect(command).toContain(`<Context docBase="${docBase}"/>`);
    expect(command).toContain("/conf/Catalina/localhost");
    expect(command).toContain("ROOT.xml");
    expect(command).not.toContain("server.xml");
    if ("appMount" in definition && definition.appMount === false) {
      expect(plan.environment.LANDO_WEBROOT).toBeUndefined();
    } else {
      expect(plan.environment.LANDO_WEBROOT).toBe(docBase);
    }
    if ("command" in definition) expect(plan.command).toEqual(definition.command);
  });

  test("leaves configuration in an authored custom image untouched", async () => {
    // Given: an image outside the catalog.
    // When: its Tomcat service is planned.
    const plan = await planTomcatService(tomcatServiceType, { type: "tomcat", image: "acme/tomcat:custom" });
    // Then: Lando does not assume ownership of the image's configuration.
    expect(plan.extensions["@lando/core/service-features"]).not.toMatchObject({
      buildSteps: expect.arrayContaining([
        expect.objectContaining({ id: "service-lando.tomcat:root-context" }),
      ]),
    });
  });

  test.each([undefined, "public"])("rejects appMount false with webroot %s", async (webroot) => {
    // Given: a webroot requiring app code on a service that disables it.
    const definition = { type: "tomcat", appMount: false, ...(webroot === undefined ? {} : { webroot }) };
    // When / Then: planning rejects the contradictory settings with remediation.
    await expect(planTomcatService(tomcatServiceType, definition)).rejects.toThrow(
      `tomcat webroot "${webroot ?? "."}" is relative to the app mount, but appMount is false. Set webroot to an absolute container path, or remove appMount: false.`,
    );
  });

  test("rejects a relative webroot outside the app mount", async () => {
    // Given / When / Then: an escaping document root fails type resolution.
    await expect(
      resolveTomcatService(tomcatServiceType, { type: "tomcat", webroot: "../x" }),
    ).rejects.toThrow(
      "tomcat webroot ../x leaves the app mount (/app); use an absolute container path instead.",
    );
  });

  test("configures ROOT when the catalog image is explicitly authored", async () => {
    // Given / When: an explicitly authored image equal to the selected catalog image.
    const plan = await planTomcatService(tomcat10ServiceType, {
      type: "tomcat:10",
      image: "tomcat:10-jre21",
    });
    // Then: the image retains Lando-owned configuration.
    expect(plan.extensions["@lando/core/service-features"]).toMatchObject({
      buildSteps: expect.arrayContaining([
        expect.objectContaining({ id: "service-lando.tomcat:root-context" }),
      ]),
    });
  });
});
