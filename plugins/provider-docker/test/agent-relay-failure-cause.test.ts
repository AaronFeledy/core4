import { expect, test } from "bun:test";
import { ProviderInternalError } from "@lando/sdk/errors";
import { AgentSocketBridgeInput } from "@lando/sdk/schema";
import { Effect, Result, Schema } from "effect";
import { makeDockerDesktopAgentSocketBridge } from "../src/agent-socket-relay.ts";

test("preserves the transport cause when opening an agent relay fails", async () => {
  // Given
  const cause = new ProviderInternalError({
    providerId: "docker",
    operation: "request",
    message: "Docker socket rejected the request.",
    remediation: "Start Docker Desktop and check its API socket permissions.",
  });
  const open = makeDockerDesktopAgentSocketBridge({
    api: { info: Effect.succeed({}), request: () => Effect.fail(cause) },
    hostGateway: "host.docker.internal",
    relayImage: "alpine/socat:test",
  });
  const input = Schema.decodeUnknownSync(AgentSocketBridgeInput)({
    appId: "failure-test",
    appRoot: "/apps/failure-test",
    sessionId: "failure-session",
    kind: "ssh",
    socketName: "agent.sock",
    upstream: { _tag: "loopback-tcp", port: 12345, token: "test-token" },
  });
  // When
  const result = await Effect.runPromise(Effect.scoped(open(input)).pipe(Effect.result));
  // Then
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) expect(result.failure.cause).toBe(cause);
});
