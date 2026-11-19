import { expect, test } from "bun:test";
import { PortablePath, ProviderId, ServiceConfig, ServiceName } from "@lando/sdk/schema";
import type { ServiceFeatureDefinition } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import { composeService } from "../../src/services/feature.ts";

const defaults: ServiceFeatureDefinition = {
  id: "test.endpoints",
  priority: 600,
  declareEndpoints: () =>
    Effect.succeed([
      { kind: "internal", name: "web", protocol: "http", port: 80 },
      { kind: "internal", name: "admin", protocol: "http", port: 9000 },
    ]),
  apply: () => Effect.void,
};

test.each([
  { wire: [], expected: [] },
  {
    wire: [{ kind: "internal", name: "web", protocol: "http", port: 8080 }],
    expected: [{ kind: "internal", name: "web", protocol: "http", port: 8080 }],
  },
  {
    wire: [{ kind: "published", protocol: "udp", port: 53, publication: { hostPort: 5353 } }],
    expected: [{ kind: "published", protocol: "udp", port: 53, publication: { hostPort: 5353 } }],
  },
  {
    wire: [{ kind: "internal", protocol: "unix", socketPath: PortablePath.make("/run/app.sock") }],
    expected: [{ kind: "internal", protocol: "unix", socketPath: PortablePath.make("/run/app.sock") }],
  },
])("replaces all feature endpoints when an endpoint list is supplied: $wire", async ({ wire, expected }) => {
  // Given
  const normalizedConfig = Schema.decodeUnknownSync(ServiceConfig)({ endpoints: wire });
  // When
  const plan = await Effect.runPromise(
    composeService({
      base: {
        name: ServiceName.make("web"),
        type: "test",
        provider: ProviderId.make("lando"),
        primary: true,
        defaultFeatures: [defaults],
      },
      baseKind: "lando",
      appRoot: "/srv/app",
      appSlug: "app",
      normalizedConfig,
      features: [],
    }),
  );
  // Then
  expect(plan.endpoints).toEqual(expected);
});
