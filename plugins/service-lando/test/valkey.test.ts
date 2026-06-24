import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, ServiceName } from "@lando/sdk/schema";

import { valkeyServiceType } from "../src/services/valkey.ts";

const metadata = {
  resolvedAt: "2026-05-28T00:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const planValkeyService = (serviceDefinition: Record<string, unknown>) => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "myapp",
    services: { cache: serviceDefinition },
  });
  const service = landofile.services?.[ServiceName.make("cache")];
  if (service === undefined) throw new Error("cache service missing");

  return valkeyServiceType.__legacyToServicePlan({
    name: "cache",
    service,
    appRoot: "/srv/apps/myapp",
    metadata,
  });
};

describe("valkey ServiceType", () => {
  test("plans a default Valkey service with persistent data volume and TCP endpoint", () => {
    const plan = planValkeyService({ type: "valkey" });

    expect(plan.type).toBe("valkey");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "valkey/valkey:8" });
    expect(plan.command).toEqual(["valkey-server", "--appendonly", "yes", "--port", "6379"]);
    expect(plan.storage).toHaveLength(1);
    expect(plan.storage[0]?.store).toBe("myapp-valkey-data");
    expect(String(plan.storage[0]?.target)).toBe("/data");
    expect(plan.endpoints).toEqual([{ port: 6379, protocol: "tcp", name: "cache" }]);
  });

  test("respects image, port, and command overrides", () => {
    const plan = planValkeyService({
      type: "valkey",
      image: "valkey/valkey:7",
      port: 16379,
      command: ["valkey-server", "--maxmemory", "256mb"],
    });

    expect(plan.artifact).toEqual({ kind: "ref", ref: "valkey/valkey:7" });
    expect(plan.command).toEqual(["valkey-server", "--maxmemory", "256mb"]);
    expect(plan.endpoints[0]?.port).toBe(16379);
  });

  test("default command tracks the overridden port", () => {
    const plan = planValkeyService({ type: "valkey", port: 16379 });

    expect(plan.command).toEqual(["valkey-server", "--appendonly", "yes", "--port", "16379"]);
  });

  test("includes a TCP healthcheck on the default port", () => {
    const plan = planValkeyService({ type: "valkey" });

    expect(plan.healthcheck).toEqual({
      kind: "command",
      command: ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/6379"],
      intervalSeconds: 10,
      timeoutSeconds: 5,
      retries: 5,
      startPeriodSeconds: 30,
    });
  });

  test("TCP healthcheck tracks the overridden port", () => {
    const plan = planValkeyService({ type: "valkey", port: 16379 });

    expect(plan.endpoints[0]?.port).toBe(16379);
    expect(plan.healthcheck?.command).toEqual(["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/16379"]);
  });

  test("sets LANDO environment variables for service context", () => {
    const plan = planValkeyService({ type: "valkey" });

    expect(plan.environment.LANDO).toBe("ON");
    expect(plan.environment.LANDO_APP_NAME).toBe("myapp");
    expect(plan.environment.LANDO_SERVICE_NAME).toBe("cache");
    expect(plan.environment.LANDO_SERVICE_TYPE).toBe("valkey");
  });

  test("user environment variables merge into the plan environment", () => {
    const plan = planValkeyService({
      type: "valkey",
      environment: { EXTRA_VAR: "extra" },
    });

    expect(plan.environment.EXTRA_VAR).toBe("extra");
  });

  test("rejects user environment that targets reserved LANDO_* keys", () => {
    expect(() => planValkeyService({ type: "valkey", environment: { LANDO_SERVICE_NAME: "evil" } })).toThrow(
      /reserved LANDO_\* keys.*LANDO_SERVICE_NAME/,
    );
  });
});
