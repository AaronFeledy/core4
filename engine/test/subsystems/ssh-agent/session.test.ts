import { expect, test } from "bun:test";
import { RedactionService } from "@lando/redaction/service";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  type AppPlan,
  type HealthcheckPlan,
  PortablePath,
  ProviderId,
  ServiceName,
} from "@lando/sdk/schema";
import { GlobalAppService, PathsService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider, makeTestRuntimeProviderRegistry } from "@lando/sdk/test";
import { Clock, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import {
  agentSocketMountPlan,
  awaitRuntimeSshAgent,
  runtimeSshAgentCheck,
  runtimeSshAgentState,
  sidecarSocketCheck,
} from "../../../src/subsystems/ssh-agent/session.ts";
import { globalPlanAt } from "../../../src/testing/global-teardown.ts";
import { pathsServiceLayer, testPaths } from "../../paths-service.ts";

const globalRoot = AbsolutePath.make("/lando/global");
const globalApp = GlobalAppService.of({
  id: "global",
  root: Effect.succeed(globalRoot),
  paths: Effect.succeed({
    root: globalRoot,
    distLandofile: AbsolutePath.make("/lando/global/.lando.dist.yml"),
    userLandofile: AbsolutePath.make("/lando/global/.lando.yml"),
  }),
  providerId: Effect.succeed(ProviderId.make("docker")),
  ensureRoot: Effect.void,
  ensureRunning: () => Effect.succeed([]),
  ensureUserLandofile: Effect.succeed({
    path: AbsolutePath.make("/lando/global/.lando.yml"),
    created: false,
  }),
  regenerateDist: () => Effect.die("unused"),
});
const readiness = {
  kind: "command",
  command: ["agent-status", "--ready"],
  user: "probe-user",
  timeoutSeconds: 5,
  intervalSeconds: 1,
  retries: 3,
  startPeriodSeconds: 10,
} satisfies HealthcheckPlan;
const applied = globalPlanAt(globalRoot, readiness);
const runningProvider = {
  ...TestRuntimeProvider,
  id: applied.provider,
  exec: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
  inspect: () =>
    Effect.succeed({
      app: applied.id,
      service: ServiceName.make("ssh-agent"),
      providerId: applied.provider,
      status: "running" as const,
      publications: { status: "unknown" as const },
    }),
};
const withProvider =
  (provider: typeof TestRuntimeProvider, plan: AppPlan | null = applied) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(PathsService, testPaths()),
      Effect.provideService(
        RuntimeProviderRegistry,
        makeTestRuntimeProviderRegistry({
          resolveAppliedPlan: (root, app, lookup) =>
            Effect.succeed(
              root === globalRoot && app?.id === applied.id && app.kind === "global" && lookup === "exact"
                ? (plan ?? undefined)
                : undefined,
            ),
          list: Effect.succeed([ProviderId.make(provider.id)]),
          capabilities: Effect.succeed(provider.capabilities),
          select: (target) =>
            Effect.succeed(
              typeof target !== "string" && target?.provider === provider.id ? provider : TestRuntimeProvider,
            ),
        }),
      ),
    );

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
    ...runningProvider,
    exec: (target, opts) =>
      Effect.succeed({
        exitCode:
          target.plan === applied &&
          target.user === "probe-user" &&
          opts.command.join(" ") === "agent-status --ready"
            ? exitCode
            : 9,
        stdout: "",
        stderr: "",
      }),
  } satisfies typeof TestRuntimeProvider;
  // When
  const state = await Effect.runPromise(
    runtimeSshAgentState.pipe(Effect.provideService(GlobalAppService, globalApp), withProvider(provider)),
  );
  // Then
  expect(state).toBe(exitCode === 0 ? "ready" : "starting");
});

test.each([
  null,
  undefined,
  { ...readiness, kind: "none" },
  { ...readiness, kind: "tcp" },
  {
    ...readiness,
    executionTarget: "host",
  },
] as const)("unusable applied evidence (%j) never runs a readiness command", async (probe) => {
  const result = await Effect.runPromise(
    runtimeSshAgentCheck.pipe(
      withProvider(
        { ...runningProvider, exec: () => Effect.die("unexpected readiness exec") },
        probe === null ? null : globalPlanAt(globalRoot, probe),
      ),
      Effect.provideService(GlobalAppService, globalApp),
    ),
  );
  expect(result.state).toBe(probe === null ? "stopped" : "starting");
  expect(result.detail).toBeDefined();
});

test.each([
  ["restarting", "starting"],
  ["exited", "stopped"],
] as const)("a %s sidecar container reads as %s without an exec", async (status, expected) => {
  // Given
  let execs = 0;
  const provider = {
    ...runningProvider,
    inspect: () => runningProvider.inspect().pipe(Effect.map((service) => ({ ...service, status }))),
    exec: () =>
      Effect.sync(() => {
        execs++;
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
  };
  // When
  const state = await Effect.runPromise(
    runtimeSshAgentState.pipe(Effect.provideService(GlobalAppService, globalApp), withProvider(provider)),
  );
  // Then
  expect(state).toBe(expected);
  expect(execs).toBe(0);
});

test.each([
  { running: true, declared: 2, deadline: 2 },
  { running: true, declared: 10, deadline: 5 },
  { running: false, declared: 2, deadline: 5 },
])(
  "a sidecar with running=$running and declared timeout $declared settles at $deadline seconds",
  async ({ running, declared, deadline }) => {
    // Given
    const provider = {
      ...runningProvider,
      inspect: () => (running ? runningProvider.inspect() : Effect.never),
      exec: () => Effect.never,
    };
    // When
    const state = await Effect.runPromise(
      Effect.gen(function* () {
        const start = yield* Clock.currentTimeMillis;
        const fiber = yield* Effect.forkChild(
          Effect.gen(function* () {
            const state = yield* runtimeSshAgentState;
            return { state, elapsed: (yield* Clock.currentTimeMillis) - start };
          }),
        );
        yield* TestClock.adjust("6 seconds");
        return yield* Fiber.join(fiber);
      }).pipe(
        Effect.provideService(GlobalAppService, globalApp),
        withProvider(provider, globalPlanAt(globalRoot, { ...readiness, timeoutSeconds: declared })),
        Effect.provide(TestClock.layer()),
      ),
    );
    // Then
    expect(state).toEqual({ state: "starting", elapsed: deadline * 1000 });
  },
);

test("wait exhausts its budget when a running agent never answers", async () => {
  // Given
  let probes = 0;
  const provider = {
    ...runningProvider,
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
      withProvider(provider),
      Effect.provide(TestClock.layer()),
    ),
  );
  // Then
  expect(state.state).toBe("starting");
  expect(state.detail).toContain("SSH readiness command exited with code 2");
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

test.each([
  { status: "exited", state: "stopped", probes: 0 },
  { status: "restarting", state: "starting", probes: 0 },
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
  // Then the socket is checked only after runtime readiness has been established.
  expect(result).toEqual(
    state === "ready" ? { state } : { state, detail: `SSH agent sidecar container status: ${status}.` },
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
    }).pipe(Effect.provide(TestClock.layer()), Effect.provide(pathsServiceLayer())),
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
  expect(result.detail).toBe("SSH readiness command timed out.");
});
