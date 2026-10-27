import { expect, test } from "bun:test";
import { AbsolutePath, PortablePath, ServiceName } from "@lando/sdk/schema";
import { Effect } from "effect";
import { plan } from "./fixture.ts";

test("gpg overlay adds isolated home, public keyring and socket only to eligible services and strips cleanly", async () => {
  // Given
  const { withGpgAgentOverlay, stripGpgAgentOverlay } = await import(
    "../../../src/subsystems/gpg-agent/overlay.ts"
  );
  // When
  const result = Effect.runSync(
    withGpgAgentOverlay(
      plan,
      {
        kind: "gpg",
        socketName: "S.gpg-agent",
        mount: { _tag: "bind-directory", directory: AbsolutePath.make("/relay/socket") },
      },
      "/relay/keyring",
    ),
  );
  // Then
  expect(result.services[ServiceName.make("web")]?.environment).toEqual({
    KEEP: "yes",
    GNUPGHOME: "/tmp/lando-gnupg",
    LANDO_GPG_AGENT_SOCKET: "/run/lando/gpg-agent/S.gpg-agent",
    LANDO_GPG_KEYRING: "/run/lando/gpg-agent-keys",
  });
  expect(result.services[ServiceName.make("web")]?.mounts).toEqual([
    {
      type: "bind",
      origin: "integration",
      source: "/relay/socket",
      target: PortablePath.make("/run/lando/gpg-agent"),
      readOnly: true,
      createHostPath: false,
      realization: "passthrough",
    },
    {
      type: "bind",
      origin: "integration",
      source: "/relay/keyring",
      target: PortablePath.make("/run/lando/gpg-agent-keys"),
      readOnly: true,
      createHostPath: false,
      realization: "passthrough",
    },
  ]);
  expect(result.services[ServiceName.make("db")]).toBe(plan.services[ServiceName.make("db")]);
  expect(stripGpgAgentOverlay(result)).toEqual(plan);
});

test("rejects when an overlay target collides with a planned mount", async () => {
  const { withGpgAgentOverlay, stripGpgAgentOverlay } = await import(
    "../../../src/subsystems/gpg-agent/overlay.ts"
  );
  const { GpgAgentTransportError } = await import("@lando/sdk/errors");
  // Given
  const web = plan.services[ServiceName.make("web")];
  if (web === undefined) throw new TypeError("Missing web fixture");
  const colliding = {
    ...plan,
    services: {
      ...plan.services,
      [ServiceName.make("web")]: {
        ...web,
        mounts: [
          {
            type: "bind" as const,
            origin: "authored" as const,
            source: "/other",
            target: PortablePath.make("/run/lando/gpg-agent"),
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
    withGpgAgentOverlay(
      stripGpgAgentOverlay(colliding),
      {
        kind: "gpg",
        socketName: "S.gpg-agent",
        mount: { _tag: "bind-directory", directory: AbsolutePath.make("/relay/socket") },
      },
      "/relay/keyring",
    ).pipe(Effect.result),
  );
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") expect(result.failure).toBeInstanceOf(GpgAgentTransportError);
});
