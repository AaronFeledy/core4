import { expect, test } from "bun:test";

import { DateTime, Effect } from "effect";

import { ProviderId, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { buildKeyForService } from "../../src/services/build-key.ts";

test("keys CA descriptors by digest and archive name but not host path", async () => {
  // Given
  const providerId = ProviderId.make("test");
  const withCa = (path: string, digest: string, archiveName: string): ServicePlan => ({
    name: ServiceName.make("web"),
    type: "node",
    provider: providerId,
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
      source: "build-key-ca.test",
      runtime: 4,
    },
    extensions: {
      "@lando/core/service-features": {
        buildSteps: [
          {
            id: "third-party:trust-store",
            phase: "build",
            command: "install-trust",
            caFiles: [{ path, digest, archiveName }],
          },
        ],
      },
    },
  });
  const key = (service: ServicePlan) =>
    Effect.runPromise(buildKeyForService({ ...TestRuntimeProvider, id: providerId }, service));

  // When
  const original = await key(withCa("/host/first.pem", "a".repeat(64), "first.crt"));
  const moved = await key(withCa("/host/second.pem", "a".repeat(64), "first.crt"));
  const changedDigest = await key(withCa("/host/first.pem", "b".repeat(64), "first.crt"));
  const changedArchiveName = await key(withCa("/host/first.pem", "a".repeat(64), "second.crt"));

  // Then
  expect(moved).toBe(original);
  expect(changedDigest).not.toBe(original);
  expect(changedArchiveName).not.toBe(original);
});
