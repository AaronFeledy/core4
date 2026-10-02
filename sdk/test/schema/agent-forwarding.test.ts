import { expect, test } from "bun:test";
import * as Contracts from "@lando/sdk/schema";
import { Either, Schema } from "effect";

test("AgentSocketBridgeResult decodes bind-directory and volume members", () => {
  // Given
  const inputs: ReadonlyArray<Contracts.AgentSocketBridgeResult> = [
    { _tag: "bind-directory", directory: Contracts.AbsolutePath.make("/run/lando/agent-session") },
    { _tag: "volume", volume: "lando-agent-session" },
  ];
  // When
  const results: ReadonlyArray<Contracts.AgentSocketBridgeResult> = inputs.map((input) =>
    Schema.decodeUnknownSync(Contracts.AgentSocketBridgeResult)(input),
  );
  // Then
  expect(results).toEqual(inputs);
});

test("AgentSocketUpstream rejects a non-integer port", () => {
  // Given
  const input = { _tag: "loopback-tcp", port: 1234.5 };
  // When
  const result = Schema.decodeUnknownEither(Contracts.AgentSocketUpstream)(input);
  // Then
  expect(Either.isLeft(result)).toBe(true);
});

test("AgentSocketBridgeInput preserves app identity, kind and upstream", () => {
  // Given
  const input: Contracts.AgentSocketBridgeInput = {
    appId: Contracts.AppId.make("myapp"),
    appRoot: Contracts.AbsolutePath.make("/apps/myapp"),
    sessionId: "session-123",
    kind: "ssh",
    upstream: { _tag: "loopback-tcp", port: 1234, token: "broker-token" },
    socketName: "agent.sock",
  };
  // When
  const result = Schema.decodeUnknownSync(Contracts.AgentSocketBridgeInput)(input);
  // Then
  expect(result).toEqual(input);
});

test.each(["bind-directory", "guest-bridge", "volume-relay"])(
  "provider agentSocket accepts %s delivery",
  (delivery) => {
    // Given
    const input = { agentSocket: { delivery } };
    expect(Contracts.ProviderCapabilities.fields).toHaveProperty("agentSocket");
    // When
    const result = Schema.decodeUnknownSync(Contracts.ProviderCapabilities.pick("agentSocket"))(input);
    // Then
    expect(result).toEqual(input);
  },
);

test("agent forwarding publishes schemas and stable container locations", () => {
  // Given
  const names = [
    "SshAgentConfig",
    "GpgAgentConfig",
    "AgentSocketKind",
    "AgentSocketDelivery",
    "AgentSocketProviderCapabilities",
    "AgentSocketUpstream",
    "AgentSocketBridgeInput",
    "AgentSocketBridgeResult",
    "SecretStoreContribution",
  ];
  // When
  const registered = new Set<string>(Contracts.JSON_SCHEMA_NAMES);
  // Then
  expect(names.filter((name) => registered.has(name))).toEqual(names);
  expect(Contracts.AGENT_SOCKET_CONTAINER_DIR).toEqual({
    ssh: "/run/lando/ssh-agent",
    gpg: "/run/lando/gpg-agent",
  });
  expect(Contracts.SSH_AGENT_SOCKET_NAME).toBe("agent.sock");
  expect(Contracts.GPG_AGENT_SOCKET_NAME).toBe("S.gpg-agent");
});

test("agent forwarding public schemas describe every field without exemptions", () => {
  // Given
  const registry = Contracts.publicSchemaRegistry;
  // When
  const issues = Contracts.validatePublicSchemaAnnotations(
    {
      SshAgentConfig: registry.SshAgentConfig,
      GpgAgentConfig: registry.GpgAgentConfig,
      AgentSocketKind: registry.AgentSocketKind,
      AgentSocketDelivery: registry.AgentSocketDelivery,
      AgentSocketProviderCapabilities: registry.AgentSocketProviderCapabilities,
      AgentSocketUpstream: registry.AgentSocketUpstream,
      AgentSocketBridgeInput: registry.AgentSocketBridgeInput,
      AgentSocketBridgeResult: registry.AgentSocketBridgeResult,
      SecretStoreContribution: registry.SecretStoreContribution,
    },
    { fields: new Set() },
  );
  // Then
  expect(issues).toEqual([]);
});
