import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { ServiceConfig } from "@lando/sdk/schema";

import { redisServiceType } from "../src/services/redis.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const metadata = { resolvedAt: "2026-09-13T00:00:00Z", source: "/srv/demo/.lando.yml", runtime: 4 as const };
const plan = (input: unknown) =>
  composeServicePlan({
    serviceType: redisServiceType,
    service: Schema.decodeUnknownSync(ServiceConfig)(input),
    appRoot: "/srv/demo",
    serviceName: "cache",
    metadata,
  });

describe("Redis authentication and persistence", () => {
  test("uses environment authentication without password argv when password is authored", async () => {
    // Given
    const password = "redis-secret ' spaces $() \\\n";
    // When
    const result = await plan({ type: "redis", password });
    // Then
    expect(result.environment.REDISCLI_AUTH).toBe(password);
    expect(JSON.stringify(result.command)).not.toContain(password);
    expect(result.command).not.toEqual(["redis-server", "--appendonly", "yes"]);
    expect(JSON.stringify(result.command)).toContain("chmod 0444 /tmp/lando-redis.conf");
    expect(result.healthcheck).toMatchObject({ kind: "command", command: ["redis-cli", "ping"] });
  });

  test("publishes credentials and env-backed tooling when password is authored", async () => {
    // Given
    const password = "redis-tooling-secret";
    const service = Schema.decodeUnknownSync(ServiceConfig)({ type: "redis", password });
    // When
    const result = await Effect.runPromise(
      redisServiceType.resolve({ name: "cache", service, appRoot: "/srv/demo", metadata }),
    );
    // Then
    expect(result.normalizedConfig.creds?.password).toBe(password);
    expect(result.tooling?.["redis-cli"]).toMatchObject({
      cmd: ["redis-cli"],
      env: { REDISCLI_AUTH: password },
    });
  });

  test("disables both disk persistence modes without storage when persist is false", async () => {
    // Given / When
    const result = await plan({ type: "redis", persist: false });
    // Then
    expect(result.storage).toEqual([]);
    expect(result.command).toEqual(["redis-server", "--appendonly", "no", "--save", ""]);
  });

  test.each([{}, { persist: true }])(
    "retains durable storage when persistence is enabled: %j",
    async (options) => {
      // Given / When
      const result = await plan({ type: "redis", ...options });
      // Then
      expect(result.storage).toHaveLength(1);
      expect(result.command).toEqual(["redis-server", "--appendonly", "yes"]);
    },
  );
});
