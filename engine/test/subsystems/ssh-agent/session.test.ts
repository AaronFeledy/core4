import { expect, test } from "bun:test";
import { RedactionService } from "@lando/redaction/service";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, PortablePath, ProviderId, ServiceName } from "@lando/sdk/schema";
import { GlobalAppService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import {
  agentSocketMountPlan,
  awaitRuntimeSshAgent,
  runtimeSshAgentState,
  sidecarSocketCheck,
} from "../../../src/subsystems/ssh-agent/session.ts";

const globalRoot = AbsolutePath.make("/lando/global");
const globalApp = GlobalAppService.of({
  id: "global",
  root: Effect.succeed(globalRoot),
  paths: Effect.succeed({
    root: globalRoot,
    distLandofile: AbsolutePath.make("/lando/global/.lando.dist.yml"),
    userLandofile: AbsolutePath.make("/lando/global/.lando.yml"),
  }),
  providerId: Effect.succeed(ProviderId.make("lando")),
  ensureRoot: Effect.void,
  ensureRunning: () => Effect.succeed([]),
  ensureUserLandofile: Effect.succeed({
    path: AbsolutePath.make("/lando/global/.lando.yml"),
    created: false,
  }),
  regenerateDist: () => Effect.die("unused"),
});

test("builds a read-only passthrough bind when the socket uses a host directory", () => {
  // Given
  const directory = AbsolutePath.make("/relay/socket");
  const target = PortablePath.make("/run/lando/ssh-agent");
  // When
  const mount = agentSocketMountPlan({ _tag: "bind-directory", directory }, target);
  // Then
  expect(mount).toEqual({
    type: "bind",
    origin: "integration",
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
        publications: { status: "unknown" as const },
      }),
    exec: () => Effect.succeed({ exitCode, stdout: "", stderr: "" }),
  };
  // When
  const state = await Effect.runPromise(
    runtimeSshAgentState.pipe(
      Effect.provideService(GlobalAppService, globalApp),
      Effect.provideService(RuntimeProviderRegistry, {
        appliedPlansFor: () => Effect.succeed([]),
        resolveAppliedPlan: () => Effect.succeed(undefined),
        resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
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
        publications: { status: "unknown" as const },
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
      Effect.provideService(GlobalAppService, globalApp),
      Effect.provideService(RuntimeProviderRegistry, {
        appliedPlansFor: () => Effect.succeed([]),
        resolveAppliedPlan: () => Effect.succeed(undefined),
        resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
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
  "a probe timeout after running=%s reads as starting, not stopped",
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
              publications: { status: "unknown" as const },
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
        Effect.provideService(GlobalAppService, globalApp),
        Effect.provideService(RuntimeProviderRegistry, {
          appliedPlansFor: () => Effect.succeed([]),
          resolveAppliedPlan: () => Effect.succeed(undefined),
          resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
          list: Effect.succeed([ProviderId.make(provider.id)]),
          capabilities: Effect.succeed(provider.capabilities),
          select: () => Effect.succeed(provider),
        }),
        Effect.provide(TestClock.layer()),
      ),
    );
    // Then
    expect(state).toBe("starting");
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
        publications: { status: "unknown" as const },
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
      Effect.provideService(GlobalAppService, globalApp),
      Effect.provideService(RuntimeProviderRegistry, {
        appliedPlansFor: () => Effect.succeed([]),
        resolveAppliedPlan: () => Effect.succeed(undefined),
        resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
        list: Effect.succeed([ProviderId.make(provider.id)]),
        capabilities: Effect.succeed(provider.capabilities),
        select: () => Effect.succeed(provider),
      }),
      Effect.provide(TestClock.layer()),
    ),
  );
  // Then
  expect(state.state).toBe("starting");
  expect(state.detail).toContain("SSH readiness shell probe exited with code 2");
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
    origin: "integration",
    store: "agent",
    target,
    readOnly: true,
  });
});

const runningProvider = {
  ...TestRuntimeProvider,
  inspect: () =>
    Effect.succeed({
      app: AppId.make("global"),
      service: ServiceName.make("ssh-agent"),
      providerId: ProviderId.make("lando"),
      status: "running",
      publications: { status: "unknown" as const },
    }),
};
const withProvider = (provider: typeof TestRuntimeProvider) =>
  Effect.provideService(RuntimeProviderRegistry, {
    appliedPlansFor: () => Effect.succeed([]),
    resolveAppliedPlan: () => Effect.succeed(undefined),
    resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
    list: Effect.succeed([ProviderId.make(provider.id)]),
    capabilities: Effect.succeed(provider.capabilities),
    select: () => Effect.succeed(provider),
  });

test.each([
  { status: "exited", state: "stopped", probes: 0 },
  { status: "restarting", state: "ready", probes: 1 },
  { status: "running", state: "ready", probes: 1 },
])("socket readiness for a $status sidecar returns $state", async ({ status, state, probes }) => {
  // Given a sidecar and a socket that answers identity requests.
  let socketProbes = 0;
  const provider = {
    ...runningProvider,
    inspect: () => runningProvider.inspect().pipe(Effect.map((service) => ({ ...service, status }))),
    exec: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
  };
  // When checking readiness through the socket.
  const result = await Effect.runPromise(
    sidecarSocketCheck({ _tag: "unix", path: "/agent.sock" }, async () => {
      socketProbes++;
      return { identities: 0 };
    }).pipe(withProvider(provider), Effect.provideService(GlobalAppService, globalApp)),
  );
  // Then stopped sidecars skip the socket; a successful socket probe proves readiness otherwise.
  expect(result).toEqual(
    state === "stopped" ? { state, detail: "SSH agent sidecar container status: exited." } : { state },
  );
  expect(socketProbes).toBe(probes);
});

test.each([false, true])(
  "exec failure is redacted with RedactionService present=%s",
  async (servicePresent) => {
    // Given an exec failure containing a secret from the source environment.
    const secret = "seeded-ssh-readiness-secret";
    const previous = process.env.LANDO_TEST_SSH_TOKEN;
    process.env.LANDO_TEST_SSH_TOKEN = secret;
    const provider = {
      ...runningProvider,
      exec: () =>
        Effect.fail(
          new ProviderUnavailableError({
            providerId: "lando",
            operation: "exec",
            message: `exec denied ${secret}`,
            remediation: "Install or start the `lando` provider and confirm it can perform `exec`.",
          }),
        ),
    };
    const wait = Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(awaitRuntimeSshAgent());
      yield* TestClock.adjust("30 seconds");
      return yield* Fiber.join(fiber);
    }).pipe(
      withProvider(provider),
      Effect.provideService(GlobalAppService, globalApp),
      Effect.provide(TestClock.layer()),
    );
    try {
      // When the readiness budget expires, with or without the optional redaction service.
      const result = await Effect.runPromise(
        servicePresent ? wait.pipe(Effect.provide(RedactionService.layer), Effect.scoped) : wait,
      );
      // Then the concrete failure survives but its seeded secret does not.
      expect(result.state).toBe("starting");
      expect(result.detail).toContain("exec denied");
      expect(result.detail).toContain("[redacted]");
      expect(result.detail).not.toContain(secret);
    } finally {
      process.env.LANDO_TEST_SSH_TOKEN = previous;
    }
  },
);

test.each([
  {
    cause: new Error("socket identity request failed", { cause: new Error("connection refused") }),
    detail: "socket identity request failed connection refused",
  },
  { cause: new Error("socket identity request failed"), detail: "socket identity request failed" },
  { cause: "connection refused", detail: "connection refused" },
])("socket readiness retains a failed identity request: $detail", async ({ cause, detail }) => {
  // Given a running sidecar whose socket rejects identity requests.
  const check = sidecarSocketCheck({ _tag: "unix", path: "/missing.sock" }, async () => {
    throw cause;
  });
  // When its readiness budget expires.
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(awaitRuntimeSshAgent(check));
      yield* TestClock.adjust("30 seconds");
      return yield* Fiber.join(fiber);
    }).pipe(
      withProvider(runningProvider),
      Effect.provideService(GlobalAppService, globalApp),
      Effect.provide(TestClock.layer()),
    ),
  );
  // Then socket failure detail is retained.
  expect(result).toEqual({ state: "starting", detail });
});

test("overall timeout retains the last completed failure rather than the interrupted attempt", async () => {
  // Given one concrete failure followed by an attempt that never completes.
  let attempts = 0;
  const check = Effect.suspend(() => {
    attempts++;
    if (attempts === 1) return Effect.fail(new Error("concrete exec refusal"));
    return attempts === 2 ? Effect.succeed({ state: "starting" as const }) : Effect.never;
  });
  // When the overall deadline interrupts the third attempt.
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(awaitRuntimeSshAgent(check));
      yield* TestClock.adjust("30 seconds");
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );
  // Then the completed failure, not ProbeTimeoutError, is the reported reason.
  expect(result).toEqual({ state: "starting", detail: "concrete exec refusal" });
});

test("per-attempt timeout is retained when exec never completes", async () => {
  // Given a running sidecar with a stuck exec transport.
  const provider = { ...runningProvider, exec: () => Effect.never };
  // When all readiness time elapses.
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(awaitRuntimeSshAgent());
      yield* TestClock.adjust("30 seconds");
      return yield* Fiber.join(fiber);
    }).pipe(
      withProvider(provider),
      Effect.provideService(GlobalAppService, globalApp),
      Effect.provide(TestClock.layer()),
    ),
  );
  // Then the completed five-second probe timeout is retained.
  expect(result.state).toBe("starting");
  expect(result.detail).toContain("5s");
});
