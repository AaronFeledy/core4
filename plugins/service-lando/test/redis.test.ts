import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, ServiceName } from "@lando/sdk/schema";

import { REDIS_FEATURE_ID, redisServiceFeature, redisServiceType } from "../src/services/redis.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const metadata = {
  resolvedAt: "2026-05-18T08:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

describe("redis ServiceType", () => {
  test("plans a default Redis service with persistent data volume and append-only command", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { cache: { type: "redis" } },
    });
    const service = landofile.services?.[ServiceName.make("cache")];
    if (service === undefined) throw new Error("cache service missing");

    const plan = await composeServicePlan({
      serviceType: redisServiceType,
      service,
      appRoot: "/srv/apps/myapp",
      serviceName: "cache",
      metadata,
      featureOverrides: new Map([[REDIS_FEATURE_ID, redisServiceFeature]]),
    });

    expect(plan.type).toBe("redis");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "redis:7" });
    expect(plan.command).toEqual(["redis-server", "--appendonly", "yes"]);
    expect(plan.storage).toHaveLength(1);
    expect(plan.storage[0]?.store).toBe("myapp-redis-data");
    expect(String(plan.storage[0]?.target)).toBe("/data");
    expect(plan.endpoints).toEqual([{ _tag: "internal", port: 6379, protocol: "tcp", name: "cache" }]);
  });

  test("respects image, port, and command overrides", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: {
        cache: {
          type: "redis",
          image: "redis:6-alpine",
          port: 16379,
          command: ["redis-server", "--maxmemory", "256mb"],
        },
      },
    });
    const service = landofile.services?.[ServiceName.make("cache")];
    if (service === undefined) throw new Error("cache service missing");

    const plan = await composeServicePlan({
      serviceType: redisServiceType,
      service,
      appRoot: "/srv/apps/myapp",
      serviceName: "cache",
      metadata,
      featureOverrides: new Map([[REDIS_FEATURE_ID, redisServiceFeature]]),
    });

    expect(plan.artifact).toEqual({ kind: "ref", ref: "redis:6-alpine" });
    expect(plan.command).toEqual(["redis-server", "--maxmemory", "256mb"]);
    expect(plan.endpoints[0]?.port).toBe(16379);
  });
});
