import { expect, test } from "bun:test";
import { AbsolutePath, PortablePath } from "@lando/sdk/schema";
import { agentSocketMountPlan } from "../../../src/subsystems/ssh-agent/session.ts";

test("builds a read-only passthrough bind when the socket uses a host directory", () => {
  // Given
  const directory = AbsolutePath.make("/relay/socket");
  const target = PortablePath.make("/run/lando/ssh-agent");
  // When
  const mount = agentSocketMountPlan({ _tag: "bind-directory", directory }, target);
  // Then
  expect(mount).toEqual({
    type: "bind",
    source: directory,
    target,
    readOnly: true,
    createHostPath: false,
    realization: "passthrough",
  });
});

test("omits bind-only fields when the socket uses a volume", () => {
  // Given
  const target = PortablePath.make("/run/lando/gpg-agent");
  // When
  const mount = agentSocketMountPlan({ _tag: "volume", volume: "agent" }, target);
  // Then
  expect(mount).toEqual({
    type: "volume",
    source: "agent",
    target,
    readOnly: true,
    realization: "passthrough",
  });
});
