import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runtimeProviderService } from "@lando/engine/runtime/bootstrap-layer-support";
import type { AgentRelayOptions } from "@lando/engine/subsystems/ssh-agent/relay";
import { sshAgentSessionPaths } from "@lando/engine/subsystems/ssh-agent/session";
import {
  AgentRelayWorkerInput,
  identifyAgentRelayWorker,
} from "@lando/engine/subsystems/ssh-agent/worker-protocol";
import { ProviderInternalError } from "@lando/sdk/errors";
import { AbsolutePath, type AgentSocketBridgeInput, type AppPlan } from "@lando/sdk/schema";
import { RuntimeProviderRegistry } from "@lando/sdk/services";
import { Cause, Effect, Layer, Schema } from "effect";
import {
  runAgentRelayWorkerProcess,
  scopedAgentRelayWorker,
} from "../../../src/cli/agent-relay/worker-runtime";

describe("agent relay worker runtime", () => {
  for (const delivery of ["bind-directory", "guest-bridge", "volume-relay"] as const) {
    for (const platform of ["linux", "win32"] as const) {
      if (delivery === "bind-directory" && platform === "win32") continue;
      test(`${delivery} reports its mount and retains resources on ${platform}`, async () => {
        // Given a provider bridge and relay factory with observable lifetimes.
        const root = await mkdtemp(join(tmpdir(), "lando-agent-worker-"));
        const input = Schema.decodeUnknownSync(AgentRelayWorkerInput)({
          app: { kind: "user", id: "test", root },
          plan: { id: "test", provider: "docker" },
          kind: "ssh",
          upstream: { _tag: "named-pipe", path: "\\\\.\\pipe\\agent" },
          delivery,
          socketName: "agent.sock",
          paths: { userDataRoot: root },
        });
        const calls: AgentSocketBridgeInput[] = [];
        const selected: (AppPlan | undefined)[] = [];
        const listeners: AgentRelayOptions[] = [];
        const closed: string[] = [];
        const provider = {
          ...runtimeProviderService,
          openAgentSocketBridge: (bridge: AgentSocketBridgeInput) =>
            Effect.acquireRelease(
              Effect.sync(() => {
                calls.push(bridge);
                return delivery === "volume-relay"
                  ? { _tag: "volume" as const, volume: "agent-volume" }
                  : { _tag: "bind-directory" as const, directory: AbsolutePath.make("/guest/agent") };
              }),
              () =>
                Effect.sync(() => {
                  closed.push("bridge");
                }),
            ),
        };
        const registry = Layer.succeed(RuntimeProviderRegistry, {
          list: Effect.succeed([]),
          capabilities: Effect.succeed(provider.capabilities),
          select: (plan) => {
            selected.push(plan);
            return Effect.succeed(provider);
          },
        });
        try {
          // When the scoped worker starts and authenticates its control identity.
          const ready = await Effect.runPromise(
            Effect.scoped(
              Effect.gen(function* () {
                const ready = yield* scopedAgentRelayWorker(input, {
                  platform,
                  createRelay: async (options) => {
                    listeners.push(options);
                    return {
                      address:
                        options.listen._tag === "unix"
                          ? { _tag: "unix", path: options.listen.path }
                          : { _tag: "loopback-tcp", port: 12345 },
                      activeConnections: () => 0,
                      close: async () => {
                        closed.push("relay");
                      },
                    };
                  },
                });
                const identity = yield* Effect.promise(() => identifyAgentRelayWorker(ready));
                expect(identity).toEqual({
                  appId: "test",
                  appRoot: AbsolutePath.make(root),
                  kind: "ssh",
                  pid: process.pid,
                  sessionId: ready.sessionId,
                  protocolVersion: 1,
                });
                expect(closed).toEqual([]);
                return ready;
              }),
            ).pipe(Effect.provide(registry)),
          );
          // Then delivery determines the listener, bridge, and published mount.
          const paths = sshAgentSessionPaths(input.app, { userDataRoot: root }, "ssh");
          expect(listeners[0]?.upstream).toEqual(input.upstream);
          if (delivery === "bind-directory") {
            expect(ready.mount).toEqual({
              _tag: "bind-directory",
              directory: AbsolutePath.make(paths.socketDir),
            });
            expect(selected).toEqual([]);
            expect(calls).toEqual([]);
            expect((await stat(paths.socketDir)).mode & 0o777).toBe(0o711);
            expect((await stat(dirname(paths.stateDir))).mode & 0o777).toBe(0o700);
          } else {
            expect(selected[0]).toMatchObject({ id: "test", provider: "docker" });
            expect(calls[0]).toMatchObject({
              appId: "test",
              appRoot: AbsolutePath.make(root),
              sessionId: ready.sessionId,
              kind: "ssh",
              socketName: "agent.sock",
            });
            expect(ready.mount).toEqual(
              delivery === "volume-relay"
                ? { _tag: "volume", volume: "agent-volume" }
                : { _tag: "bind-directory", directory: AbsolutePath.make("/guest/agent") },
            );
          }
          const tcp = delivery === "volume-relay" || platform === "win32";
          expect(listeners[0]?.listen).toEqual(
            tcp
              ? {
                  _tag: "loopback-tcp",
                  ...(delivery === "volume-relay" ? { token: expect.stringMatching(/^[\w-]{43}$/) } : {}),
                }
              : { _tag: "unix", path: join(paths.socketDir, "agent.sock"), mode: 0o666 },
          );
          if (tcp)
            expect(calls[0]?.upstream).toEqual({
              _tag: "loopback-tcp",
              port: 12345,
              ...(delivery === "volume-relay" && listeners[0]?.listen._tag === "loopback-tcp"
                ? { token: listeners[0].listen.token }
                : {}),
            });
          expect(closed).toEqual(delivery === "bind-directory" ? ["relay"] : ["bridge", "relay"]);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      });
    }
  }

  test("bridge failure releases the relay before readiness", async () => {
    // Given a provider whose bridge fails after acquiring a resource.
    const root = await mkdtemp(join(tmpdir(), "lando-agent-failure-"));
    const closed: string[] = [];
    const input = Schema.decodeUnknownSync(AgentRelayWorkerInput)({
      app: { kind: "user", id: "test", root },
      plan: { id: "test", provider: "docker" },
      kind: "ssh",
      upstream: { _tag: "unix", path: "/agent.sock" },
      delivery: "volume-relay",
      socketName: "agent.sock",
      paths: { userDataRoot: root },
    });
    const provider = {
      ...runtimeProviderService,
      openAgentSocketBridge: () =>
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              closed.push("bridge");
            }),
          );
          return yield* Effect.fail(
            new ProviderInternalError({ providerId: "docker", operation: "bridge", message: "failed" }),
          );
        }),
    };
    try {
      // When bridge acquisition fails.
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          scopedAgentRelayWorker(input, {
            createRelay: async () => ({
              address: { _tag: "loopback-tcp", port: 12345 },
              activeConnections: () => 0,
              close: async () => {
                closed.push("relay");
              },
            }),
          }),
        ).pipe(
          Effect.provideService(RuntimeProviderRegistry, {
            list: Effect.succeed([]),
            capabilities: Effect.succeed(provider.capabilities),
            select: () => Effect.succeed(provider),
          }),
        ),
      );
      // Then no ready value exists and both acquired resources are released.
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value).toMatchObject({
            _tag: "SshAgentTransportError",
            stage: "bridge",
            cause: { _tag: "ProviderInternalError", message: "failed" },
          });
        }
      }
      expect(closed).toEqual(["bridge", "relay"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("bind-directory worker never constructs a provider runtime and keeps run private", async () => {
    // Given a loose run directory and a runtime factory that records construction.
    const root = await mkdtemp(join(tmpdir(), "lando-agent-lazy-"));
    const runRoot = join(root, "run");
    await mkdir(runRoot, { mode: 0o755 });
    await chmod(runRoot, 0o755);
    const constructed: string[] = [];
    const started = Promise.withResolvers<void>();
    const until = Promise.withResolvers<void>();
    const input = {
      app: { kind: "user", id: "test", root },
      plan: { id: "test", provider: "docker" },
      kind: "ssh",
      upstream: { _tag: "unix", path: join(root, "upstream.sock") },
      delivery: "bind-directory",
      socketName: "agent.sock",
      paths: { userDataRoot: root },
    };
    try {
      // When the worker process starts for bind-directory delivery.
      const pending = runAgentRelayWorkerProcess({
        readInput: async () => JSON.stringify(input),
        until: until.promise,
        loadRuntime: () => {
          constructed.push("runtime");
          return Layer.succeed(RuntimeProviderRegistry, {
            list: Effect.succeed([]),
            capabilities: Effect.succeed(runtimeProviderService.capabilities),
            select: () => Effect.succeed(runtimeProviderService),
          });
        },
        createRelay: async (options) => {
          started.resolve();
          return {
            address:
              options.listen._tag === "unix"
                ? { _tag: "unix" as const, path: options.listen.path }
                : { _tag: "loopback-tcp" as const, port: 1 },
            activeConnections: () => 0,
            close: async () => undefined,
          };
        },
      });
      await started.promise;
      // Then no provider runtime is built, and the run parent is private while the socket dir stays traversable.
      expect(constructed).toEqual([]);
      expect((await stat(runRoot)).mode & 0o777).toBe(0o700);
      const paths = sshAgentSessionPaths(
        { id: "test", root: AbsolutePath.make(root) },
        { userDataRoot: root },
        "ssh",
      );
      expect((await stat(paths.socketDir)).mode & 0o777).toBe(0o711);
      until.resolve();
      await pending;
    } finally {
      until.resolve();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("guest-bridge worker constructs a provider runtime", async () => {
    // Given a runtime factory that records construction.
    const root = await mkdtemp(join(tmpdir(), "lando-agent-runtime-"));
    const constructed: string[] = [];
    const input = {
      app: { kind: "user", id: "test", root },
      plan: { id: "test", provider: "docker" },
      kind: "ssh",
      upstream: { _tag: "named-pipe", path: "\\\\.\\pipe\\agent" },
      delivery: "guest-bridge",
      socketName: "agent.sock",
      paths: { userDataRoot: root },
    };
    try {
      // When the worker process starts for guest-bridge delivery.
      await runAgentRelayWorkerProcess({
        platform: "linux",
        readInput: async () => JSON.stringify(input),
        until: Promise.resolve(),
        loadRuntime: () => {
          constructed.push("runtime");
          return Layer.succeed(RuntimeProviderRegistry, {
            list: Effect.succeed([]),
            capabilities: Effect.succeed(runtimeProviderService.capabilities),
            select: () => Effect.succeed(runtimeProviderService),
          });
        },
        createRelay: async () => ({
          address: { _tag: "unix" as const, path: join(root, "agent.sock") },
          activeConnections: () => 0,
          close: async () => undefined,
        }),
      }).catch(() => undefined);
      // Then the provider runtime is constructed.
      expect(constructed).toEqual(["runtime"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
