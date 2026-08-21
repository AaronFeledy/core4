import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { LandofileShape, ServiceName } from "@lando/sdk/schema";
import { DotnetServiceConfig } from "@lando/sdk/schema/services/dotnet";
import type { ServiceType } from "@lando/sdk/services";

import {
  DOTNET_FEATURE_ID,
  dotnet80ServiceType,
  dotnet90ServiceType,
  dotnetServiceFeature,
  dotnetServiceType,
} from "../src/services/dotnet.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const metadata = {
  resolvedAt: "2026-08-20T00:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const APP_ROOT = "/srv/apps/myapp";
const featureOverrides = new Map([[DOTNET_FEATURE_ID, dotnetServiceFeature]]);

const serviceConfig = (serviceDefinition: Record<string, unknown>) => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "myapp",
    services: { api: serviceDefinition },
  });
  const service = landofile.services?.[ServiceName.make("api")];
  if (service === undefined) throw new Error("api service missing");
  return service;
};

const planDotnetService = (serviceType: ServiceType, serviceDefinition: Record<string, unknown>) =>
  composeServicePlan({
    serviceType,
    service: serviceConfig(serviceDefinition),
    appRoot: APP_ROOT,
    appName: "myapp",
    serviceName: "api",
    metadata,
    featureOverrides,
  });

const resolveDotnetService = (serviceType: ServiceType, serviceDefinition: Record<string, unknown>) =>
  Effect.runPromise(
    serviceType.resolve({
      name: "api",
      service: serviceConfig(serviceDefinition),
      appRoot: APP_ROOT,
      appName: "myapp",
      metadata,
    }),
  );

describe("dotnet ServiceType", () => {
  test("declares catalog ids, versions, artifacts, base, and schema", () => {
    const serviceTypes = [dotnetServiceType, dotnet80ServiceType, dotnet90ServiceType];

    expect(serviceTypes.map(({ id }) => id)).toEqual(["dotnet", "dotnet:8.0", "dotnet:9.0"]);
    for (const serviceType of serviceTypes) {
      expect(serviceType.base).toBe("lando");
      expect(serviceType.schema).toBe(DotnetServiceConfig);
      expect(serviceType.versions).toEqual(["8.0", "9.0"]);
      expect(serviceType.artifacts).toEqual({
        "8.0": "mcr.microsoft.com/dotnet/sdk:8.0",
        "9.0": "mcr.microsoft.com/dotnet/sdk:9.0",
      });
    }
  });

  for (const [id, image, serviceType] of [
    ["dotnet", "mcr.microsoft.com/dotnet/sdk:9.0", dotnetServiceType],
    ["dotnet:8.0", "mcr.microsoft.com/dotnet/sdk:8.0", dotnet80ServiceType],
    ["dotnet:9.0", "mcr.microsoft.com/dotnet/sdk:9.0", dotnet90ServiceType],
  ] as const) {
    test(`plans ${id} with its SDK artifact`, async () => {
      const plan = await planDotnetService(serviceType, { type: id });

      expect(plan.type).toBe("dotnet");
      expect(plan.artifact).toEqual({ kind: "ref", ref: image });
    });
  }

  test("plans keepalive, app mount, NuGet cache, and HTTP endpoint defaults", async () => {
    const plan = await planDotnetService(dotnetServiceType, { type: "dotnet" });

    expect(plan.command).toEqual(["sh", "-c", "tail -f /dev/null"]);
    expect(String(plan.workingDirectory)).toBe("/app");
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
    expect(plan.storage).toHaveLength(1);
    expect(plan.storage[0]).toMatchObject({ store: "lando-cache-nuget", readOnly: false });
    expect(String(plan.storage[0]?.target)).toBe("/root/.nuget/packages");
    expect(plan.endpoints).toEqual([{ _tag: "internal", port: 5000, protocol: "http", name: "api" }]);
  });

  test("resolves the default route, certificates, and NuGet cache metadata", async () => {
    const resolution = await resolveDotnetService(dotnetServiceType, { type: "dotnet" });

    expect(resolution.normalizedConfig.routes).toEqual([{ hostname: "api.myapp.lndo.site", endpoint: 5000 }]);
    expect(resolution.normalizedConfig.certs).toBe(true);
    expect(resolution.normalizedConfig.storage).toContainEqual({
      store: "lando-cache-nuget",
      target: "/root/.nuget/packages",
      readOnly: false,
      kind: "cache",
      key: "nuget",
    });
  });

  test("authored image, port, command, and user replace runtime defaults", async () => {
    const plan = await planDotnetService(dotnetServiceType, {
      type: "dotnet",
      image: "registry.example.test/dotnet-sdk:custom",
      port: 8123,
      command: ["dotnet", "watch"],
      user: "1000:1000",
    });

    expect(plan.artifact).toEqual({ kind: "ref", ref: "registry.example.test/dotnet-sdk:custom" });
    expect(plan.endpoints).toEqual([{ _tag: "internal", port: 8123, protocol: "http", name: "api" }]);
    expect(plan.command).toEqual(["dotnet", "watch"]);
    expect(plan.user).toBe("1000:1000");
  });

  test("authored routes replace the default route", async () => {
    const routes = [{ hostname: "dotnet.example.test", scheme: "https", endpoint: 9443 }] as const;
    const resolution = await resolveDotnetService(dotnetServiceType, { type: "dotnet", routes });

    expect(resolution.normalizedConfig.routes).toEqual(routes);
  });
});
