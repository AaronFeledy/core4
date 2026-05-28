import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, ServiceName } from "@lando/sdk/schema";

import { memcachedServiceType } from "../src/services/memcached.ts";

const metadata = {
  resolvedAt: "2026-05-28T00:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const planMemcachedService = (serviceDefinition: Record<string, unknown>) => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "myapp",
    services: { cache: serviceDefinition },
  });
  const service = landofile.services?.[ServiceName.make("cache")];
  if (service === undefined) throw new Error("cache service missing");

  return memcachedServiceType.toServicePlan({
    name: "cache",
    service,
    appRoot: "/srv/apps/myapp",
    metadata,
  });
};

describe("memcached ServiceType", () => {
  test("plans a default in-memory Memcached service with a TCP endpoint", () => {
    const plan = planMemcachedService({ type: "memcached" });

    expect(plan.type).toBe("memcached");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "memcached:1.6" });
    expect(plan.command).toEqual(["memcached", "-p", "11211"]);
    expect(plan.endpoints).toEqual([{ port: 11211, protocol: "tcp", name: "cache" }]);
    expect(plan.storage).toEqual([]);
  });

  test("respects image, port, and command overrides", () => {
    const plan = planMemcachedService({
      type: "memcached",
      image: "memcached:1.6-bookworm",
      port: 21211,
      command: ["memcached", "-m", "128"],
    });

    expect(plan.artifact).toEqual({ kind: "ref", ref: "memcached:1.6-bookworm" });
    expect(plan.endpoints[0]?.port).toBe(21211);
    expect(plan.command).toEqual(["memcached", "-m", "128"]);
  });

  test("default command tracks the overridden port", () => {
    const plan = planMemcachedService({ type: "memcached", port: 21211 });

    expect(plan.command).toEqual(["memcached", "-p", "21211"]);
  });

  test("includes a TCP healthcheck on port 11211", () => {
    const plan = planMemcachedService({ type: "memcached" });

    expect(plan.healthcheck).toEqual({
      kind: "command",
      command: ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/11211"],
      intervalSeconds: 10,
      timeoutSeconds: 5,
      retries: 5,
      startPeriodSeconds: 30,
    });
  });

  test("TCP healthcheck tracks the overridden port", () => {
    const plan = planMemcachedService({ type: "memcached", port: 21211 });

    expect(plan.endpoints[0]?.port).toBe(21211);
    expect(plan.healthcheck?.command).toEqual(["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/21211"]);
  });

  test("sets LANDO environment variables for service context", () => {
    const plan = planMemcachedService({ type: "memcached" });

    expect(plan.environment.LANDO).toBe("ON");
    expect(plan.environment.LANDO_APP_NAME).toBe("myapp");
    expect(plan.environment.LANDO_SERVICE_NAME).toBe("cache");
    expect(plan.environment.LANDO_SERVICE_TYPE).toBe("memcached");
  });

  test("user environment variables merge into the plan environment", () => {
    const plan = planMemcachedService({
      type: "memcached",
      environment: { EXTRA_VAR: "extra" },
    });

    expect(plan.environment.EXTRA_VAR).toBe("extra");
  });

  test("rejects user environment that targets reserved LANDO_* keys", () => {
    expect(() =>
      planMemcachedService({ type: "memcached", environment: { LANDO_SERVICE_NAME: "evil" } }),
    ).toThrow(/reserved LANDO_\* keys.*LANDO_SERVICE_NAME/);
  });
});
