import { expect, test } from "bun:test";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { DateTime } from "effect";

const overlayFixture = (): AppPlan => {
  const metadata = {
    resolvedAt: DateTime.unsafeMake("2026-01-01T00:00:00Z"),
    source: "test",
    runtime: 4,
  } satisfies AppPlan["metadata"];
  const service = (name: string, extensions: ServicePlan["extensions"]): ServicePlan => ({
    name: ServiceName.make(name),
    type: "lando",
    provider: ProviderId.make("lando"),
    primary: true,
    environment: { KEEP: "yes" },
    mounts: [],
    storage: [],
    endpoints: [],
    routes: [],
    dependsOn: [],
    hostAliases: [],
    metadata,
    extensions,
  });
  return {
    id: AppId.make("demo"),
    name: "demo",
    slug: "demo",
    root: AbsolutePath.make("/app/demo"),
    provider: ProviderId.make("lando"),
    services: {
      [ServiceName.make("web")]: service("web", { "@lando/core/ssh-agent": { mode: "host" } }),
      [ServiceName.make("db")]: service("db", {}),
    },
    routes: [],
    networks: [],
    stores: [],
    fileSync: [],
    metadata,
    extensions: {},
  };
};

test("adds SSH_AUTH_SOCK and a read-only directory mount only to eligible services", async () => {
  const { withSshAgentOverlay } = await import("../../../src/subsystems/ssh-agent/overlay.ts");
  // Given
  const plan = overlayFixture();
  // When
  const result = withSshAgentOverlay(plan, {
    kind: "ssh",
    socketName: "agent.sock",
    mount: { _tag: "bind-directory", directory: AbsolutePath.make("/relay/socket") },
  });
  // Then
  expect(result.services[ServiceName.make("web")]?.environment).toEqual({
    KEEP: "yes",
    SSH_AUTH_SOCK: "/run/lando/ssh-agent/agent.sock",
  });
  expect(result.services[ServiceName.make("web")]?.mounts).toEqual([
    {
      type: "bind",
      source: "/relay/socket",
      target: PortablePath.make("/run/lando/ssh-agent"),
      readOnly: true,
      createHostPath: false,
      realization: "passthrough",
    },
  ]);
  expect(result.services[ServiceName.make("db")]).toBe(plan.services[ServiceName.make("db")]);
});

test("strip removes the overlay and volume delivery replaces rather than duplicates mounts", async () => {
  const { withSshAgentOverlay, stripSshAgentOverlay } = await import(
    "../../../src/subsystems/ssh-agent/overlay.ts"
  );
  // Given
  const plan = overlayFixture();
  const session = {
    kind: "ssh" as const,
    socketName: "agent.sock",
    mount: { _tag: "volume" as const, volume: "agent-volume" },
  };
  const overlaid = withSshAgentOverlay(withSshAgentOverlay(plan, session), session);
  // When
  const result = stripSshAgentOverlay(overlaid);
  // Then
  expect(overlaid.services[ServiceName.make("web")]?.mounts).toHaveLength(1);
  expect(overlaid.services[ServiceName.make("web")]?.mounts[0]).toMatchObject({
    type: "volume",
    source: "agent-volume",
    readOnly: true,
  });
  expect(result).toEqual(plan);
});
