import { expect, test } from "bun:test";
import { ProviderId, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { DateTime, Effect } from "effect";
import type { ServiceConfigSource } from "../../src/planner/service-config-files.ts";
import { buildKeyForService } from "../../src/services/build-key.ts";

const server: ServiceConfigSource = {
  key: "server",
  authored: "server.conf",
  source: "/app/server.conf",
  digest: "a".repeat(64),
};
const dir: ServiceConfigSource = {
  key: "dir",
  authored: "conf",
  source: "/app/conf",
  digest: "b".repeat(64),
};
const key = (configSources: ReadonlyArray<ServiceConfigSource>) => {
  const service: ServicePlan = {
    name: ServiceName.make("db"),
    type: "postgres",
    provider: ProviderId.make("test"),
    primary: true,
    environment: {},
    mounts: [],
    storage: [],
    endpoints: [],
    routes: [],
    dependsOn: [],
    hostAliases: [],
    metadata: {
      resolvedAt: DateTime.unsafeMake("2026-07-30T00:00:00.000Z"),
      source: "config-sources.test",
      runtime: 4,
    },
    extensions: { "@lando/core/service-features": { configSources } },
  };
  return Effect.runPromise(buildKeyForService(TestRuntimeProvider, service));
};

test("changes the build key when only a config source digest changes", async () => {
  // Given
  const original = await key([server]);
  // When
  const changed = await key([{ ...server, digest: "c".repeat(64) }]);
  // Then
  expect(changed).not.toBe(original);
});

test("keeps the build key stable when config sources are reordered", async () => {
  // Given
  const original = await key([server, dir]);
  // When
  const reordered = await key([dir, server]);
  // Then
  expect(reordered).toBe(original);
});
