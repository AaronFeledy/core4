import { expect, test } from "bun:test";
import { AbsolutePath, ServiceName } from "@lando/sdk/schema";
import { ProcessRunner, RuntimeProviderRegistry, type RuntimeProviderShape } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Result, Stream } from "effect";
import { planWith } from "../services/build-app-runner-test-support.ts";
import { registryLayer } from "./fixtures/error-registry.ts";

const web = ServiceName.make("web");
const probe = {
  kind: "command",
  command: ["probe", "$HOME", ""],
  intervalSeconds: 0,
  timeoutSeconds: 1,
  retries: 0,
} as const;

test.each(["host", "service"] as const)(
  "apply delegates %s attempts with the actual invocation plan",
  async (target) => {
    // Given
    const readiness =
      target === "host" ? { ...probe, executionTarget: target } : { ...probe, user: "1001:1002" };
    const original = planWith({ web: [] }, { web: { readiness } });
    const actual = { ...original, root: AbsolutePath.make("/tmp/actual-invocation") };
    const seen: unknown[] = [];
    const runtime: RuntimeProviderShape = {
      ...TestRuntimeProvider,
      apply: (plan, options) => {
        const delegate = options.executeReadinessAttempt;
        if (delegate === undefined) return Effect.die("Missing attempt delegate");
        const check = plan.services[web]?.readiness;
        if (check === undefined) return Effect.die("Missing readiness");
        return delegate(web, check).pipe(Effect.as({ changed: false }));
      },
      exec: (target, command) =>
        Effect.sync(() => {
          seen.push({ target, command });
          return { exitCode: 0, stdout: "", stderr: "" };
        }),
    };
    const processRunner = ProcessRunner.of({
      run: (options) =>
        Effect.sync(() => {
          seen.push(options);
          return { exitCode: 0, stdout: "", stderr: "" };
        }),
      stream: () => Stream.empty,
      streamWithExit: () => Stream.empty,
    });
    // When
    await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* RuntimeProviderRegistry;
        const provider = yield* registry.select(original);
        yield* provider.apply(actual, { reconcile: false });
        yield* provider.apply(original, { reconcile: false });
      }).pipe(
        Effect.scoped,
        Effect.provide(
          registryLayer(runtime).pipe(Layer.provide(Layer.succeed(ProcessRunner, processRunner))),
        ),
      ),
    );
    // Then
    expect(seen).toEqual(
      target === "host"
        ? [actual, original].map((plan) => ({
            cmd: "probe",
            args: ["$HOME", ""],
            cwd: plan.root,
            capture: true,
          }))
        : [actual, original].map((plan) => ({
            target: { app: plan.id, service: web, plan, user: "1001:1002" },
            command: { command: [...probe.command], raw: true },
          })),
    );
  },
);

test("missing host runners fail before invoking provider apply", async () => {
  // Given
  const plan = planWith({ web: [] }, { web: { readiness: { ...probe, executionTarget: "host" } } });
  let actions = 0;
  const runtime = {
    ...TestRuntimeProvider,
    apply: () =>
      Effect.sync(() => {
        actions += 1;
        return { changed: true };
      }),
  };
  // When
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* RuntimeProviderRegistry;
      const provider = yield* registry.select(plan);
      return yield* Effect.result(provider.apply(plan, { reconcile: false }));
    }).pipe(Effect.scoped, Effect.provide(registryLayer(runtime))),
  );
  // Then
  expect(actions).toBe(0);
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) expect(result.failure._tag).toBe("HealthcheckTargetUnsupportedError");
});

test("apply abort interrupts the delegated attempt without retry or retained scope", async () => {
  // Given
  const plan = planWith({ web: [] }, { web: { readiness: { ...probe, executionTarget: "host" } } });
  const controller = new AbortController();
  const entered = Deferred.makeUnsafe<void>();
  let finalized = 0;
  let attempts = 0;
  const runtime: RuntimeProviderShape = {
    ...TestRuntimeProvider,
    apply: (_plan, options) => {
      const delegate = options.executeReadinessAttempt;
      return delegate === undefined
        ? Effect.die("Missing delegate")
        : delegate(web, { ...probe, executionTarget: "host" }).pipe(Effect.as({ changed: false }));
    },
  };
  const processRunner = ProcessRunner.of({
    run: () =>
      Effect.sync(() => {
        attempts += 1;
      }).pipe(
        Effect.andThen(Deferred.succeed(entered, undefined)),
        Effect.andThen(Effect.never),
        Effect.ensuring(
          Effect.sync(() => {
            finalized += 1;
          }),
        ),
      ),
    stream: () => Stream.empty,
    streamWithExit: () => Stream.empty,
  });
  // When
  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* RuntimeProviderRegistry;
      const provider = yield* registry.select(plan);
      const child = yield* Effect.forkChild(
        provider.apply(plan, { reconcile: false, signal: controller.signal }),
      );
      yield* Deferred.await(entered);
      controller.abort();
      return yield* Fiber.await(child);
    }).pipe(
      Effect.scoped,
      Effect.provide(registryLayer(runtime).pipe(Layer.provide(Layer.succeed(ProcessRunner, processRunner)))),
    ),
  );
  // Then
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
  expect({ attempts, finalized }).toEqual({ attempts: 1, finalized: 1 });
});
