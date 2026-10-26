import { expect, test } from "bun:test";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { Effect } from "effect";
import { startDetachedAgentRelayWorker } from "../../../src/subsystems/ssh-agent/detached-worker.ts";
import { relayHarness } from "./reuse-harness.ts";

test("registers fresh and reused control tokens before returning a session", async () => {
  // Given
  const { cleanup, options } = await relayHarness("ssh", "volume-relay");
  const registered: string[] = [];
  const redaction = {
    ...makeRedactionService(),
    registerValues: (values: readonly string[]) =>
      Effect.sync(() => {
        registered.push(...values);
      }),
  };
  try {
    // When
    await Effect.runPromise(
      startDetachedAgentRelayWorker(options).pipe(Effect.provideService(RedactionService, redaction)),
    );
    await Effect.runPromise(
      startDetachedAgentRelayWorker(options).pipe(Effect.provideService(RedactionService, redaction)),
    );
    // Then
    expect(registered).toEqual(["secret-1", "secret-1"]);
  } finally {
    await cleanup();
  }
});

for (const kind of ["ssh", "gpg"] as const) {
  test.each(["bind-directory", "guest-bridge", "volume-relay"] as const)(
    `${kind} reuses a healthy matching %s worker without touching its state`,
    async (delivery) => {
      // Given
      const { cleanup, options, state, sessionPaths } = await relayHarness(kind, delivery);
      try {
        const first = await Effect.runPromise(startDetachedAgentRelayWorker(options));
        const record = await readFile(sessionPaths.recordPath, "utf8");
        const before = await stat(sessionPaths.socketDir);
        await writeFile(join(sessionPaths.stateDir, "retained"), "keep");
        // When
        const second = await Effect.runPromise(startDetachedAgentRelayWorker(options));
        // Then
        expect(state.spawned).toBe(1);
        expect(state.terminated).toBe(0);
        expect(second.sessionId).toBe(first.sessionId);
        expect(second.mount).toEqual(first.mount);
        expect(await readFile(sessionPaths.recordPath, "utf8")).toBe(record);
        expect((await stat(sessionPaths.socketDir)).ino).toBe(before.ino);
        expect(await readFile(join(sessionPaths.stateDir, "retained"), "utf8")).toBe("keep");
        await second.close();
        await second.close();
        expect(await second.closed).toBeUndefined();
        expect(state.terminated).toBe(1);
      } finally {
        await cleanup();
      }
    },
  );
}

test.each([
  "upstream",
  "upstream-kind",
  "delivery",
  "socketName",
  "provider",
  "plan-id",
  "app-kind",
  "paths",
  "platform",
  "missing-endpoint",
  "dead",
] as const)("replaces a worker when %s changes", async (change) => {
  // Given
  const { root, cleanup, options, state, sessionPaths } = await relayHarness("ssh", "bind-directory");
  try {
    const first = await Effect.runPromise(startDetachedAgentRelayWorker(options));
    if (change === "missing-endpoint") await rm(join(sessionPaths.socketDir, options.socketName));
    if (change === "dead") state.alive = false;
    const changed = {
      ...options,
      ...(change === "upstream" ? { upstream: { _tag: "unix" as const, path: "/different" } } : {}),
      ...(change === "upstream-kind"
        ? { upstream: { _tag: "named-pipe" as const, path: "/upstream/agent" } }
        : {}),
      ...(change === "delivery" ? { delivery: "volume-relay" as const } : {}),
      ...(change === "socketName" ? { socketName: "other.sock" } : {}),
      ...(change === "provider"
        ? {
            plan: {
              ...options.plan,
              provider: (await import("@lando/sdk/schema")).ProviderId.make("docker"),
            },
          }
        : {}),
      ...(change === "plan-id"
        ? { plan: { ...options.plan, id: (await import("@lando/sdk/schema")).AppId.make("other") } }
        : {}),
      ...(change === "app-kind" ? { app: { ...options.app, kind: "scratch" as const } } : {}),
      ...(change === "paths" ? { paths: { ...options.paths, userConfRoot: join(root, "other") } } : {}),
      ...(change === "platform" ? { paths: { ...options.paths, platform: "darwin" } } : {}),
    };
    // When
    const second = await Effect.runPromise(startDetachedAgentRelayWorker(changed));
    // Then
    expect(state.spawned).toBe(2);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(state.terminated).toBe(change === "dead" ? 0 : 1);
  } finally {
    await cleanup();
  }
});

test("replaces an authenticated v1 worker but never reuses it", async () => {
  // Given
  const { cleanup, options, state, sessionPaths } = await relayHarness("ssh", "bind-directory");
  try {
    const first = await Effect.runPromise(startDetachedAgentRelayWorker(options));
    const { TerminableAgentRelayWorkerRecord } = await import(
      "../../../src/subsystems/ssh-agent/worker-protocol.ts"
    );
    const { Schema } = await import("effect");
    const { configDigest: _digest, ...fields } = JSON.parse(await readFile(sessionPaths.recordPath, "utf8"));
    const legacy = Schema.decodeUnknownSync(TerminableAgentRelayWorkerRecord)({
      ...fields,
      protocolVersion: 1,
    });
    await writeFile(sessionPaths.recordPath, JSON.stringify(legacy));
    // When
    const second = await Effect.runPromise(
      startDetachedAgentRelayWorker({
        ...options,
        identify: async (record) => (record.protocolVersion === 1 ? legacy : options.identify()),
      }),
    );
    // Then
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(state.spawned).toBe(2);
    expect(state.terminated).toBe(1);
  } finally {
    await cleanup();
  }
});

test("a different worker entry invalidates reuse", async () => {
  // Given
  const { cleanup, options, state } = await relayHarness("ssh", "bind-directory");
  const composition = globalThis.__landoEngineCompositionInputs;
  if (composition === undefined) throw new Error("Missing test composition");
  try {
    await Effect.runPromise(startDetachedAgentRelayWorker(options));
    globalThis.__landoEngineCompositionInputs = {
      ...composition,
      hostProxyWorkerEntry: () => ({ ...composition.hostProxyWorkerEntry(), entryPath: "/other/entry.ts" }),
    };
    // When
    await Effect.runPromise(startDetachedAgentRelayWorker(options));
    // Then
    expect(state.spawned).toBe(2);
    expect(state.terminated).toBe(1);
  } finally {
    globalThis.__landoEngineCompositionInputs = composition;
    await cleanup();
  }
});

test("closing an older reused session does not terminate its replacement", async () => {
  // Given
  const { cleanup, options, state } = await relayHarness("ssh", "volume-relay");
  try {
    await Effect.runPromise(startDetachedAgentRelayWorker(options));
    const reused = await Effect.runPromise(startDetachedAgentRelayWorker(options));
    await Effect.runPromise(
      startDetachedAgentRelayWorker({
        ...options,
        upstream: { _tag: "unix", path: "/new/upstream" },
      }),
    );
    // When
    await reused.close();
    // Then
    expect(state.spawned).toBe(2);
    expect(state.terminated).toBe(1);
    expect(state.alive).toBe(true);
  } finally {
    await cleanup();
  }
});

test.each([
  "foreign-app",
  "foreign-root",
  "kind",
  "private",
  "corrupt",
  "identify",
  "unauthenticated",
] as const)("fails closed without spawning or signaling when ownership is %s", async (failure) => {
  // Given
  const { cleanup, options, state, sessionPaths } = await relayHarness("ssh", "bind-directory");
  try {
    await Effect.runPromise(startDetachedAgentRelayWorker(options));
    const record = JSON.parse(await readFile(sessionPaths.recordPath, "utf8"));
    if (failure === "foreign-app") record.appId = "foreign";
    if (failure === "foreign-root") record.appRoot = "/foreign";
    if (failure === "kind") record.kind = "gpg";
    await writeFile(sessionPaths.recordPath, failure === "corrupt" ? "{broken" : JSON.stringify(record));
    // When
    const result = await Effect.runPromise(
      Effect.result(
        startDetachedAgentRelayWorker({
          ...options,
          privateFileAccess: {
            ...options.privateFileAccess,
            verify: async () => {
              if (failure === "private") throw new Error("Not private");
            },
          },
          identify: async () => {
            if (failure === "unauthenticated") throw new Error("Authentication failed");
            const identity = await options.identify();
            return failure === "identify" ? { ...identity, sessionId: "another" } : identity;
          },
        }),
      ),
    );
    // Then
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "SshAgentTransportError" } });
    expect(state.spawned).toBe(1);
    expect(state.terminated).toBe(0);
  } finally {
    await cleanup();
  }
});
