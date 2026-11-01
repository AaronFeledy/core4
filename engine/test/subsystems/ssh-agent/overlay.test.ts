import { expect, test } from "bun:test";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type MountPlan,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { DateTime, Effect } from "effect";

const overlayFixture = (): AppPlan => {
  const metadata = {
    resolvedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
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
  const result = Effect.runSync(
    withSshAgentOverlay(plan, {
      kind: "ssh",
      socketName: "agent.sock",
      mount: { _tag: "bind-directory", directory: AbsolutePath.make("/relay/socket") },
    }),
  );
  // Then
  expect(result.services[ServiceName.make("web")]?.environment).toEqual({
    KEEP: "yes",
    SSH_AUTH_SOCK: "/run/lando/ssh-agent/agent.sock",
  });
  expect(result.services[ServiceName.make("web")]?.mounts).toEqual([
    {
      type: "bind",
      origin: "integration",
      source: "/relay/socket",
      target: PortablePath.make("/run/lando/ssh-agent"),
      readOnly: true,
      createHostPath: false,
      realization: "passthrough",
    },
  ]);
  expect(result.services[ServiceName.make("db")]).toBe(plan.services[ServiceName.make("db")]);
});

test("strip removes the overlay and volume delivery rejects duplicate targets", async () => {
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
  const overlaid = Effect.runSync(withSshAgentOverlay(plan, session));
  const duplicate = Effect.runSync(withSshAgentOverlay(overlaid, session).pipe(Effect.result));
  // When
  const result = stripSshAgentOverlay(overlaid);
  // Then
  expect(overlaid.services[ServiceName.make("web")]?.mounts).toHaveLength(1);
  expect(overlaid.services[ServiceName.make("web")]?.mounts[0]).toMatchObject({
    type: "volume",
    store: "agent-volume",
    readOnly: true,
  });
  expect(result).toEqual(plan);
  expect(duplicate._tag).toBe("Failure");
  if (duplicate._tag === "Failure") expect(duplicate.failure._tag).toBe("SshAgentTransportError");
});

test("rejects when the overlay target collides with a planned mount", async () => {
  const { withSshAgentOverlay, stripSshAgentOverlay } = await import(
    "../../../src/subsystems/ssh-agent/overlay.ts"
  );
  const { SshAgentTransportError } = await import("@lando/sdk/errors");
  // Given an eligible service already claiming the agent socket directory
  const plan = overlayFixture();
  const web = plan.services[ServiceName.make("web")];
  if (web === undefined) throw new Error("missing web");
  const colliding = {
    ...plan,
    services: {
      ...plan.services,
      [web.name]: {
        ...web,
        mounts: [
          {
            type: "bind" as const,
            origin: "authored" as const,
            source: "/other",
            target: PortablePath.make("/run/lando/ssh-agent"),
            readOnly: true,
            createHostPath: false,
            realization: "passthrough" as const,
          },
        ],
      },
    },
  };
  // When/Then
  const result = Effect.runSync(
    withSshAgentOverlay(stripSshAgentOverlay(colliding), {
      kind: "ssh",
      socketName: "agent.sock",
      mount: { _tag: "bind-directory", directory: AbsolutePath.make("/relay/socket") },
    }).pipe(Effect.result),
  );
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") expect(result.failure).toBeInstanceOf(SshAgentTransportError);
});

for (const mount of [
  { _tag: "bind-directory", directory: AbsolutePath.make("/relay/socket") },
  { _tag: "volume", volume: "agent-volume" },
] as const) {
  test(`shares known hosts with eligible services using ${mount._tag} delivery`, async () => {
    const { withSshAgentOverlay, stripSshAgentOverlay } = await import(
      "../../../src/subsystems/ssh-agent/overlay.ts"
    );
    const plan = overlayFixture();
    const session = { kind: "ssh" as const, socketName: "agent.sock", mount };
    const result = Effect.runSync(
      withSshAgentOverlay(plan, session, { knownHostsFile: "/home/user/.ssh/known_hosts" }),
    );
    expect(result.services[ServiceName.make("web")]?.mounts).toContainEqual({
      type: "bind",
      origin: "integration",
      source: "/home/user/.ssh/known_hosts",
      target: PortablePath.make("/etc/ssh/ssh_known_hosts"),
      readOnly: true,
      createHostPath: false,
      realization: "passthrough",
    });
    expect(result.services[ServiceName.make("db")]).toBe(plan.services[ServiceName.make("db")]);
    expect(stripSshAgentOverlay(result)).toEqual(plan);
    const duplicate = Effect.runSync(
      withSshAgentOverlay(result, session, { knownHostsFile: "/home/user/.ssh/known_hosts" }).pipe(
        Effect.result,
      ),
    );
    expect(duplicate._tag).toBe("Failure");
    if (duplicate._tag === "Failure") expect(duplicate.failure.message).toContain("/run/lando/ssh-agent");
  });
}

for (const target of [
  "/etc/ssh/ssh_known_hosts",
  "/etc/ssh/ssh_known_hosts/",
  "/etc/ssh",
  "/etc/ssh/",
  "/etc",
  "/",
]) {
  test(`keeps authored ownership at ${target} instead of binding known hosts`, async () => {
    const { withSshAgentOverlay, stripSshAgentOverlay } = await import(
      "../../../src/subsystems/ssh-agent/overlay.ts"
    );
    const plan = overlayFixture();
    const web = plan.services[ServiceName.make("web")];
    if (web === undefined) throw new Error("missing web");
    const authored: MountPlan = {
      type: "bind",
      origin: "authored",
      source: "/custom",
      target: PortablePath.make(target),
      readOnly: true,
      createHostPath: false,
      realization: "passthrough",
    };
    const input = { ...plan, services: { ...plan.services, [web.name]: { ...web, mounts: [authored] } } };
    const result = Effect.runSync(
      withSshAgentOverlay(
        input,
        { kind: "ssh", socketName: "agent.sock", mount: { _tag: "volume", volume: "agent-volume" } },
        { knownHostsFile: "/home/user/.ssh/known_hosts" },
      ),
    );
    expect(result.services[web.name]?.mounts).toHaveLength(2);
    expect(result.services[web.name]?.mounts).toContainEqual(authored);
    expect(stripSshAgentOverlay(result)).toEqual(input);
  });
}

test("strips unmarked known-hosts overlays", async () => {
  const { stripSshAgentOverlay } = await import("../../../src/subsystems/ssh-agent/overlay.ts");
  const plan = overlayFixture();
  const web = plan.services[ServiceName.make("web")];
  if (web === undefined) throw new Error("missing web");
  const mount: MountPlan = {
    type: "bind",
    source: "/host/known_hosts",
    target: PortablePath.make("/etc/ssh/ssh_known_hosts"),
    readOnly: true,
    createHostPath: false,
    realization: "passthrough",
  };
  const input = { ...plan, services: { ...plan.services, [web.name]: { ...web, mounts: [mount] } } };
  expect(stripSshAgentOverlay(input)).toEqual(plan);
});
