import { expect, test } from "bun:test";
import { AbsolutePath, AppId, PortablePath, ProviderId, ServiceName } from "@lando/sdk/schema";
import { RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import {
  agentSocketMountPlan,
  awaitRuntimeSshAgent,
  runtimeSshAgentState,
} from "../../../src/subsystems/ssh-agent/session.ts";

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

test.each([0, 2])("running agent exec exit %s distinguishes ready from starting", async (exitCode) => {
  // Given
  const provider = {
    ...TestRuntimeProvider,
    inspect: () =>
      Effect.succeed({
        app: AppId.make("global"),
        service: ServiceName.make("ssh-agent"),
        providerId: ProviderId.make("lando"),
        status: "running",
      }),
    exec: () => Effect.succeed({ exitCode, stdout: "", stderr: "" }),
  };
  // When
  const state = await Effect.runPromise(
    runtimeSshAgentState.pipe(
      Effect.provideService(RuntimeProviderRegistry, {
        list: Effect.succeed([ProviderId.make(provider.id)]),
        capabilities: Effect.succeed(provider.capabilities),
        select: () => Effect.succeed(provider),
      }),
    ),
  );
  // Then
  expect(state).toBe(exitCode === 0 ? "ready" : "starting");
});

test.each([
  ["restarting", "starting"],
  ["exited", "stopped"],
] as const)("a %s sidecar container reads as %s without an exec", async (status, expected) => {
  // Given
  let execs = 0;
  const provider = {
    ...TestRuntimeProvider,
    inspect: () =>
      Effect.succeed({
        app: AppId.make("global"),
        service: ServiceName.make("ssh-agent"),
        providerId: ProviderId.make("lando"),
        status,
      }),
    exec: () =>
      Effect.sync(() => {
        execs++;
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
  };
  // When
  const state = await Effect.runPromise(
    runtimeSshAgentState.pipe(
      Effect.provideService(RuntimeProviderRegistry, {
        list: Effect.succeed([ProviderId.make(provider.id)]),
        capabilities: Effect.succeed(provider.capabilities),
        select: () => Effect.succeed(provider),
      }),
    ),
  );
  // Then
  expect(state).toBe(expected);
  expect(execs).toBe(0);
});

test.each([false, true])(
  "timeout after running=%s preserves the observed container state",
  async (running) => {
    // Given
    const provider = {
      ...TestRuntimeProvider,
      inspect: () =>
        running
          ? Effect.succeed({
              app: AppId.make("global"),
              service: ServiceName.make("ssh-agent"),
              providerId: ProviderId.make("lando"),
              status: "running",
            })
          : Effect.never,
      exec: () => Effect.never,
    };
    // When
    const state = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(runtimeSshAgentState);
        yield* TestClock.adjust("5 seconds");
        return yield* Fiber.join(fiber);
      }).pipe(
        Effect.provideService(RuntimeProviderRegistry, {
          list: Effect.succeed([ProviderId.make(provider.id)]),
          capabilities: Effect.succeed(provider.capabilities),
          select: () => Effect.succeed(provider),
        }),
        Effect.provide(TestClock.layer()),
      ),
    );
    // Then
    expect(state).toBe(running ? "starting" : "stopped");
  },
);

test("wait exhausts its budget when a running agent never answers", async () => {
  // Given
  let probes = 0;
  const provider = {
    ...TestRuntimeProvider,
    inspect: () =>
      Effect.succeed({
        app: AppId.make("global"),
        service: ServiceName.make("ssh-agent"),
        providerId: ProviderId.make("lando"),
        status: "running",
      }),
    exec: () =>
      Effect.sync(() => {
        probes++;
        return { exitCode: 2, stdout: "", stderr: "" };
      }),
  };
  // When
  const state = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(awaitRuntimeSshAgent());
      yield* TestClock.adjust("30 seconds");
      return yield* Fiber.join(fiber);
    }).pipe(
      Effect.provideService(RuntimeProviderRegistry, {
        list: Effect.succeed([ProviderId.make(provider.id)]),
        capabilities: Effect.succeed(provider.capabilities),
        select: () => Effect.succeed(provider),
      }),
      Effect.provide(TestClock.layer()),
    ),
  );
  // Then
  expect(state).toBe("starting");
  expect(probes).toBe(60);
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
