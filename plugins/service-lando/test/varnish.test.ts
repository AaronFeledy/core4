import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { ServiceTypeError } from "@lando/sdk/errors";
import { LandofileShape, ServiceName, VarnishServiceConfig } from "@lando/sdk/schema";
import type { ServiceType } from "@lando/sdk/services";

import {
  VARNISH_FEATURE_ID,
  VARNISH_VCL_TARGET,
  varnish6ServiceType,
  varnish7ServiceType,
  varnishServiceFeature,
  varnishServiceType,
} from "../src/services/varnish.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const metadata = {
  resolvedAt: "2026-08-19T00:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const featureOverrides = new Map([[VARNISH_FEATURE_ID, varnishServiceFeature]]);

const serviceConfig = (serviceDefinition: Record<string, unknown>) => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "myapp",
    services: { cache: serviceDefinition },
  });
  const service = landofile.services?.[ServiceName.make("cache")];
  if (service === undefined) throw new Error("cache service missing");
  return service;
};

const planVarnishService = async (serviceType: ServiceType, serviceDefinition: Record<string, unknown>) =>
  composeServicePlan({
    serviceType,
    service: serviceConfig(serviceDefinition),
    appRoot: "/srv/apps/myapp",
    appName: "myapp",
    serviceName: "cache",
    metadata,
    featureOverrides,
  });

const resolveVarnishService = (serviceType: ServiceType, serviceDefinition: Record<string, unknown>) =>
  Effect.runPromise(
    serviceType.resolve({
      name: "cache",
      service: serviceConfig(serviceDefinition),
      appRoot: "/srv/apps/myapp",
      appName: "myapp",
      metadata,
    }),
  );

const vclMount = (plan: Awaited<ReturnType<typeof planVarnishService>>) =>
  plan.mounts.find((mount) => String(mount.target) === VARNISH_VCL_TARGET);

describe("varnish ServiceType", () => {
  for (const [id, image, serviceType] of [
    ["varnish:6", "varnish:6", varnish6ServiceType],
    ["varnish:7", "varnish:7", varnish7ServiceType],
    ["varnish", "varnish:7", varnishServiceType],
  ] as const) {
    describe(id, () => {
      test("plans the catalog defaults in front of a named backend", async () => {
        const plan = await planVarnishService(serviceType, { type: id, backend: "appserver" });

        expect(serviceType.base).toBe("lando");
        expect(serviceType.schema).toBe(VarnishServiceConfig);
        expect(plan.type).toBe("varnish");
        expect(plan.artifact).toEqual({ kind: "ref", ref: image });
        expect(plan.endpoints).toEqual([{ _tag: "internal", port: 80, protocol: "http", name: "cache" }]);
        expect(plan.user).toBe("root");
        expect(plan.environment).toMatchObject({
          VARNISH_BACKEND_HOST: "appserver",
          VARNISH_BACKEND_PORT: "80",
          VARNISH_VCL_FILE: "/tmp/lando-backend.vcl",
        });
        expect(plan.healthcheck).toEqual({
          kind: "command",
          command: ["varnishadm", "ping"],
          intervalSeconds: 10,
          timeoutSeconds: 5,
          retries: 5,
          startPeriodSeconds: 5,
        });
        expect(plan.entrypoint).toEqual(["/bin/sh", "-c"]);
        expect(plan.command?.[0]).toContain("lando-backend.vcl");
        expect(plan.command?.[0]).toContain("varnishd -F");
        expect(plan.command?.[0]).toContain("-j none");
        expect(plan.dependsOn).toEqual([
          { service: ServiceName.make("appserver"), condition: "service_healthy", required: true },
        ]);
      });

      test("resolves a default route and enables certs", async () => {
        const resolution = await resolveVarnishService(serviceType, { type: id, backend: "appserver" });

        expect(resolution.normalizedConfig.routes).toEqual([
          { hostname: "cache.myapp.lndo.site", endpoint: 80 },
        ]);
        expect(resolution.normalizedConfig.certs).toBe(true);
        expect(resolution.normalizedConfig.backend).toBe("appserver");
      });

      test("keeps an authored VCL override mount and skips generated VCL", async () => {
        const plan = await planVarnishService(serviceType, {
          type: id,
          backend: "appserver",
          mounts: [{ source: "./default.vcl", target: VARNISH_VCL_TARGET }],
        });

        expect(vclMount(plan)).toMatchObject({
          type: "bind",
          source: "/srv/apps/myapp/default.vcl",
          readOnly: true,
        });
        expect(plan.environment?.VARNISH_VCL_FILE).toBeUndefined();
        expect(plan.entrypoint).toEqual(["/bin/sh", "-c"]);
        expect(plan.command?.[0]).toContain("/etc/varnish/default.vcl");
        expect(plan.command?.[0]).toContain("varnishd -F");
        expect(plan.command?.[0]).not.toContain("lando-backend.vcl");
      });

      test("fails closed when backend is missing", async () => {
        const result = await Effect.runPromise(
          serviceType
            .resolve({
              name: "cache",
              service: serviceConfig({ type: id }),
              appRoot: "/srv/apps/myapp",
              appName: "myapp",
              metadata,
            })
            .pipe(Effect.either),
        );

        expect(result._tag).toBe("Left");
        if (result._tag !== "Left") throw new Error("expected missing backend to fail");
        expect(result.left).toBeInstanceOf(ServiceTypeError);
        expect(result.left.message).toContain("backend:");
        expect(result.left.message).toContain("cache");
      });
    });
  }

  test("resolves a short-form VCL override against the app root", async () => {
    const plan = await planVarnishService(varnishServiceType, {
      type: "varnish",
      backend: "appserver",
      mounts: ["./custom.vcl:/etc/varnish/default.vcl:ro"],
    });

    expect(vclMount(plan)).toMatchObject({
      type: "bind",
      source: "/srv/apps/myapp/custom.vcl",
      readOnly: true,
    });
    expect(plan.environment?.VARNISH_VCL_FILE).toBeUndefined();
  });

  test("preserves a Windows drive-letter VCL override source", async () => {
    const plan = await planVarnishService(varnishServiceType, {
      type: "varnish",
      backend: "appserver",
      mounts: ["C:\\src\\default.vcl:/etc/varnish/default.vcl:ro"],
    });

    expect(vclMount(plan)).toMatchObject({
      type: "bind",
      source: "C:\\src\\default.vcl",
      readOnly: true,
    });
  });

  test("preserves an authored user", async () => {
    const plan = await planVarnishService(varnishServiceType, {
      type: "varnish",
      backend: "appserver",
      user: "1000:1000",
    });

    expect(plan.user).toBe("1000:1000");
  });

  test("declares supported versions and artifacts", () => {
    expect(varnishServiceType.versions).toEqual(["6", "7"]);
    expect(varnishServiceType.artifacts).toEqual({
      "6": "varnish:6",
      "7": "varnish:7",
    });
  });
});
