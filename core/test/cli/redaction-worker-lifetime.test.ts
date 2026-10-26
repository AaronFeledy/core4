import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRelayWorkerInput } from "@lando/engine/subsystems/ssh-agent/worker-protocol";
import { RedactionService, createStandaloneRedactor, makeRedactionOwner } from "@lando/redaction/service";
import { Effect, Schema } from "effect";
import {
  runAgentRelayWorkerProcess,
  scopedAgentRelayWorker,
} from "../../src/cli/agent-relay/worker-runtime.ts";

const inputFor = (root: string) =>
  Schema.decodeUnknownSync(AgentRelayWorkerInput)({
    app: { kind: "user", id: "redaction-worker", root },
    plan: { id: "redaction-worker", provider: "docker" },
    kind: "ssh",
    configDigest: "redaction-worker-digest",
    upstream: { _tag: "loopback-tcp", port: 23456, token: "upstream-worker-private-canary" },
    token: "relay-worker-private-canary",
    delivery: "bind-directory",
    socketName: "agent.sock",
    paths: { userDataRoot: root },
  });

test("a worker without a full runtime sanitizes startup failure before disposing its owner", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-redaction-worker-"));
  const input = inputFor(root);
  try {
    // When
    const failure = await runAgentRelayWorkerProcess({
      readInput: async () => JSON.stringify(Schema.encodeSync(AgentRelayWorkerInput)(input)),
      createRelay: async () => {
        throw new Error("upstream-worker-private-canary relay-worker-private-canary");
      },
    }).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    // Then
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain("upstream-worker-private-canary");
    expect(String(failure)).not.toContain("relay-worker-private-canary");
    expect(createStandaloneRedactor("secrets").redactString("upstream-worker-private-canary")).toBe(
      "upstream-worker-private-canary",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retained worker redactors observe tokens registered during startup without global publication", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-redaction-worker-owner-"));
  const owner = makeRedactionOwner();
  const retained = await Effect.runPromise(owner.service.forProfile("secrets"));
  let observed = "";
  try {
    // When
    await Effect.runPromise(
      Effect.scoped(
        scopedAgentRelayWorker(inputFor(root), {
          createRelay: async () => {
            observed = retained.redactString("upstream-worker-private-canary");
            throw new Error("stop before creating any listeners");
          },
        }),
      ).pipe(Effect.result, Effect.provideService(RedactionService, owner.service)),
    );
    // Then
    expect(observed).toBe("[redacted]");
    expect(retained.redactString("upstream-worker-private-canary")).toBe("[redacted]");
    expect(createStandaloneRedactor("secrets").redactString("upstream-worker-private-canary")).toBe(
      "upstream-worker-private-canary",
    );
  } finally {
    owner.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
