import { expect, test } from "bun:test";
import { GlobalConfig, GlobalConfigView } from "@lando/sdk/schema";
import { Schema } from "effect";

test("GlobalConfig accepts sshAgent, gpgAgent and defaultSecretStore and the view keeps them", () => {
  // Given
  const input = {
    sshAgent: { sidecar: false, socket: "/tmp/agent.sock" },
    gpgAgent: { forward: true, socket: "/tmp/S.gpg-agent.extra" },
    defaultSecretStore: "1password",
  };
  // When
  const loaded = Schema.decodeUnknownSync(GlobalConfig)(input, { onExcessProperty: "error" });
  const view = Schema.encodeSync(GlobalConfigView)(loaded);
  // Then
  expect(loaded).toMatchObject(input);
  expect(view).toMatchObject(input);
});
