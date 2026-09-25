import { expect, test } from "bun:test";
import { AbsolutePath, PortablePath, ServiceName } from "@lando/sdk/schema";
import { plan } from "./fixture.ts";

test("gpg overlay adds isolated home, public keyring and socket only to eligible services and strips cleanly", async () => {
  // Given
  const { withGpgAgentOverlay, stripGpgAgentOverlay } = await import(
    "../../../src/subsystems/gpg-agent/overlay.ts"
  );
  // When
  const result = withGpgAgentOverlay(
    plan,
    {
      kind: "gpg",
      socketName: "S.gpg-agent",
      mount: { _tag: "bind-directory", directory: AbsolutePath.make("/relay/socket") },
    },
    "/relay/keyring",
  );
  // Then
  expect(result.services[ServiceName.make("web")]?.environment).toEqual({
    KEEP: "yes",
    GNUPGHOME: "/run/lando/gnupg",
    LANDO_GPG_AGENT_SOCKET: "/run/lando/gpg-agent/S.gpg-agent",
    LANDO_GPG_KEYRING: "/run/lando/gpg-agent-keys",
  });
  expect(result.services[ServiceName.make("web")]?.mounts).toEqual([
    {
      type: "bind",
      source: "/relay/socket",
      target: PortablePath.make("/run/lando/gpg-agent"),
      readOnly: true,
      createHostPath: false,
      realization: "passthrough",
    },
    {
      type: "bind",
      source: "/relay/keyring",
      target: PortablePath.make("/run/lando/gpg-agent-keys"),
      readOnly: true,
      createHostPath: false,
      realization: "passthrough",
    },
    {
      type: "tmpfs",
      target: PortablePath.make("/run/lando/gnupg"),
      readOnly: false,
      realization: "passthrough",
    },
  ]);
  expect(result.services[ServiceName.make("db")]).toBe(plan.services[ServiceName.make("db")]);
  expect(stripGpgAgentOverlay(result)).toEqual(plan);
});
