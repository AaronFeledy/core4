import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, ServiceName } from "@lando/sdk/schema";

import {
  MEMCACHED_FEATURE_ID,
  memcachedServiceFeature,
  memcachedServiceType,
} from "../src/services/memcached.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const metadata = {
  resolvedAt: "2026-05-28T00:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const planMemcachedService = async (serviceDefinition: Record<string, unknown>) => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "myapp",
    services: { cache: serviceDefinition },
  });
  const service = landofile.services?.[ServiceName.make("cache")];
  if (service === undefined) throw new Error("cache service missing");

  return composeServicePlan({
    serviceType: memcachedServiceType,
    service,
    appRoot: "/srv/apps/myapp",
    appName: "myapp",
    serviceName: "cache",
    metadata,
    featureOverrides: new Map([[MEMCACHED_FEATURE_ID, memcachedServiceFeature]]),
  });
};

describe("memcached ServiceType", () => {
  test("plans a default in-memory Memcached service with a TCP endpoint", async () => {
    const plan = await planMemcachedService({ type: "memcached" });

    expect(plan.type).toBe("memcached");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "memcached:1.6" });
    expect(plan.command).toEqual(["memcached", "-p", "11211"]);
    expect(plan.endpoints).toEqual([{ _tag: "internal", port: 11211, protocol: "tcp", name: "cache" }]);
    expect(plan.storage).toEqual([]);
    expect(plan.appMount).toBeUndefined();
  });

  test("respects image, port, and command overrides", async () => {
    const plan = await planMemcachedService({
      type: "memcached",
      image: "memcached:1.6-bookworm",
      port: 21211,
      command: ["memcached", "-m", "128"],
    });

    expect(plan.artifact).toEqual({ kind: "ref", ref: "memcached:1.6-bookworm" });
    expect(plan.endpoints[0]?.port).toBe(21211);
    expect(plan.command).toEqual(["memcached", "-m", "128"]);
  });

  test("default command tracks the overridden port", async () => {
    const plan = await planMemcachedService({ type: "memcached", port: 21211 });

    expect(plan.command).toEqual(["memcached", "-p", "21211"]);
  });

  test("includes a TCP healthcheck on port 11211", async () => {
    const plan = await planMemcachedService({ type: "memcached" });

    expect(plan.healthcheck).toEqual({
      kind: "command",
      command: ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/11211"],
      intervalSeconds: 10,
      timeoutSeconds: 5,
      retries: 5,
      startPeriodSeconds: 30,
    });
  });

  test("TCP healthcheck tracks the overridden port", async () => {
    const plan = await planMemcachedService({ type: "memcached", port: 21211 });

    expect(plan.endpoints[0]?.port).toBe(21211);
    expect(plan.healthcheck?.command).toEqual(["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/21211"]);
  });

  test("user environment variables merge into the plan environment", async () => {
    const plan = await planMemcachedService({
      type: "memcached",
      environment: { EXTRA_VAR: "extra" },
    });

    expect(plan.environment).toMatchObject({ EXTRA_VAR: "extra" });
  });

  test("passes through dependencies and optional process fields", async () => {
    const plan = await planMemcachedService({
      type: "memcached",
      dependsOn: ["db"],
      entrypoint: ["docker-entrypoint.sh"],
      workingDirectory: "/tmp",
      user: "memcache",
    });

    expect(plan.dependsOn).toEqual([{ service: ServiceName.make("db"), condition: "started" }]);
    expect(plan.entrypoint).toEqual(["docker-entrypoint.sh"]);
    expect(String(plan.workingDirectory)).toBe("/tmp");
    expect(plan.user).toBe("memcache");
  });
});
