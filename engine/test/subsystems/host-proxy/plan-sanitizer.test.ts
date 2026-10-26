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

import * as AppPlanSanitizerLayer from "../../../src/subsystems/host-proxy/plan-sanitizer-live.ts";
import {
  HOST_PROXY_CONTAINER_LANDO,
  HOST_PROXY_TRANSPORT_EXTENSION_KEY,
  stripHostProxyRunLando,
} from "../../../src/subsystems/host-proxy/transport-feature.ts";

test("AppPlanSanitizer delegates host-proxy persistence sanitization", async () => {
  // Given
  const metadata = {
    resolvedAt: DateTime.makeUnsafe("2026-07-26T00:00:00Z"),
    source: "plan-sanitizer.test",
    runtime: 4,
  } satisfies AppPlan["metadata"];
  const service = {
    name: ServiceName.make("web"),
    type: "lando",
    serviceTypeId: "derived-web",
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
      ...["/usr/local/bin/xdg-open", "/usr/local/bin/open"].map((target) => ({
        type: "bind" as const,
        source: "/tmp/lando-shim",
        target: PortablePath.make(target),
        readOnly: true,
        realization: "passthrough" as const,
      })),
      {
        type: "bind",
        source: "/tmp/lando-shim",
        target: PortablePath.make(HOST_PROXY_CONTAINER_LANDO),
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
    }).pipe(Effect.provide(AppPlanSanitizerLayer.layer)),
  );

  // Then
  expect(sanitized).toEqual(stripHostProxyRunLando(fixturePlan));
  expect(sanitized.services[service.name]?.serviceTypeId).toBe("derived-web");
  expect(sanitized.services[service.name]?.mounts).toEqual([
    {
      type: "volume",
      source: "app-data",
      target: PortablePath.make("/data"),
      readOnly: false,
      realization: "passthrough",
    },
  ]);
});

test("sanitizer strips ssh-agent overlay", async () => {
  const { withSshAgentOverlay } = await import("../../../src/subsystems/ssh-agent/overlay.ts");
  // Given
  const metadata = {
    resolvedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
    source: "sanitizer-test",
    runtime: 4,
  } satisfies AppPlan["metadata"];
  const service: ServicePlan = {
    name: ServiceName.make("web"),
    type: "lando",
    provider: ProviderId.make("lando"),
    primary: true,
    environment: {},
    mounts: [],
    storage: [],
    endpoints: [],
    routes: [],
    dependsOn: [],
    hostAliases: [],
    metadata,
    extensions: { "@lando/core/ssh-agent": { mode: "host" } },
  };
  const plan: AppPlan = {
    id: AppId.make("demo"),
    name: "demo",
    slug: "demo",
    root: AbsolutePath.make("/app/demo"),
    provider: ProviderId.make("lando"),
    services: { [service.name]: service },
    routes: [],
    stores: [],
    fileSync: [],
    metadata,
    extensions: {},
  };
  const overlaid = withSshAgentOverlay(plan, {
    kind: "ssh",
    socketName: "agent.sock",
    mount: { _tag: "volume", volume: "agent" },
  });
  // When
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      return (yield* AppPlanSanitizer).sanitizeForPersistence(overlaid);
    }).pipe(Effect.provide(AppPlanSanitizerLayer.layer)),
  );
  // Then
  expect(result).toEqual(plan);
});

test("sanitizer strips gpg-agent overlay", async () => {
  const { withGpgAgentOverlay } = await import("../../../src/subsystems/gpg-agent/overlay.ts");
  // Given
  const metadata = {
    resolvedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
    source: "sanitizer-test",
    runtime: 4,
  } satisfies AppPlan["metadata"];
  const service: ServicePlan = {
    name: ServiceName.make("web"),
    type: "lando",
    provider: ProviderId.make("lando"),
    primary: true,
    environment: { KEEP_ME: "yes" },
    mounts: [],
    storage: [],
    endpoints: [],
    routes: [],
    dependsOn: [],
    hostAliases: [],
    metadata,
    extensions: { "@lando/core/gpg-agent": { forward: true } },
  };
  const plan: AppPlan = {
    id: AppId.make("demo"),
    name: "demo",
    slug: "demo",
    root: AbsolutePath.make("/app/demo"),
    provider: ProviderId.make("lando"),
    services: { [service.name]: service },
    routes: [],
    stores: [],
    fileSync: [],
    metadata,
    extensions: {},
  };
  const overlaid = withGpgAgentOverlay(
    plan,
    {
      kind: "gpg",
      socketName: "S.gpg-agent",
      mount: { _tag: "bind-directory", directory: AbsolutePath.make("/relay/gpg-socket") },
    },
    "/relay/gpg-keyring",
  );
  expect(overlaid.services[service.name]?.environment.GNUPGHOME).toBe("/tmp/lando-gnupg");
  expect(overlaid.services[service.name]?.mounts).toHaveLength(2);
  // When
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      return (yield* AppPlanSanitizer).sanitizeForPersistence(overlaid);
    }).pipe(Effect.provide(AppPlanSanitizerLayer.layer)),
  );
  // Then
  expect(result).toEqual(plan);
});
