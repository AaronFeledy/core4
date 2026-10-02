import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { PortablePath, ProviderId, ServiceConfig, ServiceName } from "@lando/sdk/schema";
import type { ServiceFeatureDefinition } from "@lando/sdk/services";
import { composeService } from "../../src/services/feature.ts";

const defaults: ServiceFeatureDefinition = {
  id: "test.endpoints",
  priority: 600,
  apply: (ctx) =>
    Effect.sync(() => {
      ctx.addEndpoint({ _tag: "internal", name: "web", protocol: "http", port: 80 });
      ctx.addEndpoint({ _tag: "internal", name: "admin", protocol: "http", port: 9000 });
    }),
};

test.each([
  { endpoints: [] },
  { endpoints: [{ _tag: "internal", name: "web", protocol: "http", port: 8080 }] },
  { endpoints: [{ _tag: "published", protocol: "udp", port: 53, publication: { hostPort: 5353 } }] },
  { endpoints: [{ _tag: "internal", protocol: "unix", socketPath: PortablePath.make("/run/app.sock") }] },
])("replaces all feature endpoints when an endpoint list is supplied: %j", async ({ endpoints }) => {
  // Given
  const normalizedConfig = Schema.decodeUnknownSync(ServiceConfig)({ endpoints });
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
      normalizedConfig,
      features: [],
    }),
  );
  // Then
  expect(plan.endpoints).toEqual(endpoints);
});
