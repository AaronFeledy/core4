import { expect, test } from "bun:test";
import { DateTime, Effect } from "effect";

import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { AppPlanSanitizer } from "@lando/sdk/services";

import { AppPlanSanitizerLive } from "../../../src/subsystems/host-proxy/plan-sanitizer-live.ts";
import {
  HOST_PROXY_CONTAINER_SHIM,
  HOST_PROXY_TRANSPORT_EXTENSION_KEY,
  stripHostProxyRunLando,
} from "../../../src/subsystems/host-proxy/transport-feature.ts";

test("AppPlanSanitizer delegates host-proxy persistence sanitization", async () => {
  // Given
  const metadata = {
    resolvedAt: DateTime.unsafeMake("2026-07-26T00:00:00Z"),
    source: "plan-sanitizer.test",
    runtime: 4,
  } satisfies AppPlan["metadata"];
  const service = {
    name: ServiceName.make("web"),
    type: "lando",
    provider: ProviderId.make("lando"),
    primary: true,
    artifact: { kind: "ref", ref: "node:22-alpine" },
    command: [],
    environment: {
      KEEP_ME: "yes",
      LANDO_HOST_PROXY_TOKEN: "secret-token",
      LANDO_HOST_PROXY_SESSION: "session-id",
    },
    mounts: [
      {
        type: "bind",
        source: "/tmp/lando-shim",
        target: PortablePath.make(HOST_PROXY_CONTAINER_SHIM),
        readOnly: true,
        realization: "passthrough",
      },
      {
        type: "volume",
        source: "app-data",
        target: PortablePath.make("/data"),
        readOnly: false,
        realization: "passthrough",
      },
    ],
    storage: [],
    endpoints: [],
    routes: [],
    dependsOn: [],
    hostAliases: [],
    metadata,
    extensions: {
      [HOST_PROXY_TRANSPORT_EXTENSION_KEY]: { sessionId: "session-id" },
      keep: true,
    },
  } satisfies ServicePlan;
  const fixturePlan = {
    id: AppId.make("demo"),
    name: "Demo",
    slug: "demo",
    root: AbsolutePath.make("/tmp/demo"),
    provider: ProviderId.make("lando"),
    services: { [service.name]: service },
    routes: [],
    networks: [],
    stores: [],
    fileSync: [],
    metadata,
    extensions: {},
  } satisfies AppPlan;

  // When
  const sanitized = await Effect.runPromise(
    Effect.gen(function* () {
      const sanitizer = yield* AppPlanSanitizer;
      return sanitizer.sanitizeForPersistence(fixturePlan);
    }).pipe(Effect.provide(AppPlanSanitizerLive)),
  );

  // Then
  expect(sanitized).toEqual(stripHostProxyRunLando(fixturePlan));
});
