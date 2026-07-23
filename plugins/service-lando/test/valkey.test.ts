import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, ServiceName } from "@lando/sdk/schema";

import { VALKEY_FEATURE_ID, valkeyServiceFeature, valkeyServiceType } from "../src/services/valkey.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const metadata = {
  resolvedAt: "2026-05-28T00:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const planValkeyService = async (serviceDefinition: Record<string, unknown>) => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "myapp",
    services: { cache: serviceDefinition },
  });
  const service = landofile.services?.[ServiceName.make("cache")];
  if (service === undefined) throw new Error("cache service missing");

  return composeServicePlan({
    serviceType: valkeyServiceType,
    service,
    appRoot: "/srv/apps/myapp",
    appName: "myapp",
    serviceName: "cache",
    metadata,
    featureOverrides: new Map([[VALKEY_FEATURE_ID, valkeyServiceFeature]]),
  });
};

describe("valkey ServiceType", () => {
  test("plans a default Valkey service with persistent data volume and TCP endpoint", async () => {
    const plan = await planValkeyService({ type: "valkey" });

    expect(plan.type).toBe("valkey");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "valkey/valkey:8" });
    expect(plan.command).toEqual(["valkey-server", "--appendonly", "yes", "--port", "6379"]);
    expect(plan.storage).toHaveLength(1);
    expect(plan.storage[0]?.store).toBe("myapp-valkey-data");
    expect(String(plan.storage[0]?.target)).toBe("/data");
    expect(plan.endpoints).toEqual([{ _tag: "internal", port: 6379, protocol: "tcp", name: "cache" }]);
    expect(plan.appMount).toBeUndefined();
  });

  test("respects image, port, and command overrides", async () => {
    const plan = await planValkeyService({
      type: "valkey",
      image: "valkey/valkey:7",
      port: 16379,
      command: ["valkey-server", "--maxmemory", "256mb"],
    });

    expect(plan.artifact).toEqual({ kind: "ref", ref: "valkey/valkey:7" });
    expect(plan.command).toEqual(["valkey-server", "--maxmemory", "256mb"]);
    expect(plan.endpoints[0]?.port).toBe(16379);
  });

  test("default command tracks the overridden port", async () => {
    const plan = await planValkeyService({ type: "valkey", port: 16379 });

    expect(plan.command).toEqual(["valkey-server", "--appendonly", "yes", "--port", "16379"]);
  });

  test("includes a TCP healthcheck on the default port", async () => {
    const plan = await planValkeyService({ type: "valkey" });

    expect(plan.healthcheck).toEqual({
      kind: "command",
      command: ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/6379"],
      intervalSeconds: 10,
      timeoutSeconds: 5,
      retries: 5,
      startPeriodSeconds: 30,
    });
  });

  test("TCP healthcheck tracks the overridden port", async () => {
    const plan = await planValkeyService({ type: "valkey", port: 16379 });

    expect(plan.endpoints[0]?.port).toBe(16379);
    expect(plan.healthcheck?.command).toEqual(["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/16379"]);
  });

  test("user environment variables merge into the plan environment", async () => {
    const plan = await planValkeyService({
      type: "valkey",
      environment: { EXTRA_VAR: "extra" },
    });

    expect(plan.environment).toMatchObject({ EXTRA_VAR: "extra" });
  });

  test("passes through dependencies and optional process fields", async () => {
    const plan = await planValkeyService({
      type: "valkey",
      dependsOn: ["db"],
      entrypoint: ["docker-entrypoint.sh"],
      workingDirectory: "/data",
      user: "valkey",
    });

    expect(plan.dependsOn).toEqual([{ service: ServiceName.make("db"), condition: "started" }]);
    expect(plan.entrypoint).toEqual(["docker-entrypoint.sh"]);
    expect(String(plan.workingDirectory)).toBe("/data");
    expect(plan.user).toBe("valkey");
  });
});
