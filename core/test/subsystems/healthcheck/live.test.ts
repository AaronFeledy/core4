import { describe, expect, test } from "bun:test";
import {
  Cause,
  Clock,
  type Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  TestClock,
  TestContext,
} from "effect";

import { HealthcheckError, HealthcheckTimeoutError, ServiceExecError } from "@lando/sdk/errors";
import { AppId, type HealthcheckPlan, ServiceName } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import {
  type ExecResult,
  type ExecTarget,
  HealthcheckRunner,
  type HealthcheckRunnerShape,
  type CommandSpec as ProviderCommandSpec,
  type ProviderError,
  RuntimeProvider,
  type RuntimeProviderShape,
} from "@lando/sdk/services";
import { TestRuntimeProvider, runHealthcheckContract } from "@lando/sdk/test";

import { RedactionService, type RedactionServiceShape } from "../../../src/redaction/service.ts";
import * as liveModule from "../../../src/subsystems/healthcheck/live.ts";

type HealthcheckExec = {
  readonly exec: (
    target: ExecTarget,
    command: ProviderCommandSpec,
  ) => Effect.Effect<ExecResult, ProviderError>;
};
type HealthcheckLiveModule = {
  readonly makeHealthcheckRunner: (deps: HealthcheckExec) => HealthcheckRunnerShape;
  readonly HealthcheckRunnerLive: Layer.Layer<HealthcheckRunner, never, RuntimeProvider>;
  readonly HealthcheckRunnerDefaultLayer: Layer.Layer<HealthcheckRunner, never, RuntimeProvider>;
};

const { HealthcheckRunnerDefaultLayer, HealthcheckRunnerLive, makeHealthcheckRunner }: HealthcheckLiveModule =
  liveModule;

const drive = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(TestContext.TestContext)));

const driveExit = <A, E>(effect: Effect.Effect<A, E, never>): Promise<Exit.Exit<A, E>> =>
  Effect.runPromiseExit(effect.pipe(Effect.provide(TestContext.TestContext)));

type TimedExit<A, E> = { readonly exit: Exit.Exit<A, E>; readonly elapsedMs: number };

const runExitUnderClock = <A, E>(
  effect: Effect.Effect<A, E, never>,
  advance: Duration.DurationInput,
): Promise<TimedExit<A, E>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const measured = Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis;
        const exit = yield* Effect.exit(effect);
        return { exit, elapsedMs: (yield* Clock.currentTimeMillis) - started };
      });
      const fiber = yield* Effect.fork(measured);
      yield* TestClock.adjust(advance);
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestContext.TestContext)),
  );

const successOf = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isSuccess(exit)) return exit.value;
  expect(Exit.isSuccess(exit)).toBe(true);
  throw new Error("expected success");
};

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const failure = Cause.failureOption(exit.cause);
  if (Option.isSome(failure)) return failure.value;
  throw new Error("expected typed failure");
};

const appId = AppId.make("myapp");
const service = ServiceName.make("web");

type ExecCall = { readonly target: ExecTarget; readonly command: ProviderCommandSpec };
type FakeExec = HealthcheckExec & { readonly calls: ExecCall[] };

const execResult = (exitCode: number): ExecResult => ({ exitCode, stdout: "", stderr: "" });

const makeExec = (execute: (call: ExecCall) => Effect.Effect<ExecResult, ProviderError>): FakeExec => {
  const calls: ExecCall[] = [];
  return {
    calls,
    exec: (target, command) => {
      const call = { target, command };
      calls.push(call);
      return execute(call);
    },
  };
};

const execSequence = (exitCodes: readonly [number, ...number[]]): FakeExec => {
  let attempt = 0;
  return makeExec(() =>
    Effect.sync(() => {
      const exitCode = exitCodes[attempt] ?? exitCodes[0];
      attempt += 1;
      return execResult(exitCode);
    }),
  );
};

const providerFailure = (message: string): ServiceExecError =>
  new ServiceExecError({ providerId: TestRuntimeProvider.id, operation: "exec", service, message });

const execFailing = (message: string): FakeExec => makeExec(() => Effect.fail(providerFailure(message)));

const execSleepingExit = (sleepFor: Duration.DurationInput, exitCode: number): FakeExec =>
  makeExec(() => Effect.sleep(sleepFor).pipe(Effect.as(execResult(exitCode))));

const commandPlan = (
  command: NonNullable<HealthcheckPlan["command"]>,
  overrides: Partial<
    Pick<HealthcheckPlan, "intervalSeconds" | "timeoutSeconds" | "retries" | "startPeriodSeconds">
  > = {},
): HealthcheckPlan => ({
  kind: "command",
  command,
  intervalSeconds: 1,
  timeoutSeconds: 5,
  retries: 1,
  ...overrides,
});

const nonePlan = (): HealthcheckPlan => ({ kind: "none", intervalSeconds: 1, timeoutSeconds: 5, retries: 1 });

const secret = "s3cr3t-token";
const marker = "[REDACTED]";

const fakeRedactString = (text: string): string => text.replaceAll(secret, marker);

const fakeRedactValue = (value: unknown): unknown => {
  if (typeof value === "string") return fakeRedactString(value);
  if (Array.isArray(value)) return value.map(fakeRedactValue);
  if (value instanceof Error) return { name: value.name, message: fakeRedactString(value.message) };
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fakeRedactValue(item)]));
  }
  return value;
};

const fakeRedactor: Redactor = { redactString: fakeRedactString, redactValue: fakeRedactValue };

const fakeRedactionService = {
  forProfile: () => Effect.succeed(fakeRedactor),
} satisfies RedactionServiceShape;

const withFakeRedaction = <A, E>(effect: Effect.Effect<A, E, never>): Effect.Effect<A, E, never> =>
  effect.pipe(Effect.provide(Layer.succeed(RedactionService, fakeRedactionService)));

describe("makeHealthcheckRunner", () => {
  test("kind none resolves skipped without calling exec", async () => {
    const fake = execSequence([0]);
    const result = await drive(makeHealthcheckRunner(fake).run(nonePlan(), appId, service));

    expect(result).toEqual({ healthy: true, service, attempts: 0, lastStatus: "skipped" });
    expect(fake.calls).toHaveLength(0);
  });

  test("command exit 0 resolves ok and normalizes string and array commands", async () => {
    const stringExec = execSequence([0]);
    const stringResult = await drive(
      makeHealthcheckRunner(stringExec).run(commandPlan("exit 0"), appId, service),
    );

    expect(stringResult).toEqual({ healthy: true, service, attempts: 1, lastStatus: "ok" });
    expect(stringExec.calls).toEqual([
      { target: { app: appId, service }, command: { command: ["sh", "-c", "exit 0"] } },
    ]);

    const arrayExec = execSequence([0]);
    await drive(makeHealthcheckRunner(arrayExec).run(commandPlan(["true"]), appId, service));

    expect(arrayExec.calls.map((call) => call.command)).toEqual([{ command: ["true"] }]);
  });

  test("command exit 1 exhausts configured retries", async () => {
    const fake = execSequence([1]);
    const timed = await runExitUnderClock(
      makeHealthcheckRunner(fake).run(
        commandPlan("exit 1", { retries: 3, intervalSeconds: 10, timeoutSeconds: 5 }),
        appId,
        service,
      ),
      "20 seconds",
    );
    const result = successOf(timed.exit);

    expect(result).toEqual({ healthy: false, service, attempts: 3, lastStatus: "exit 1" });
    expect(fake.calls).toHaveLength(3);
  });

  test("fixed retry backoff waits only between attempts", async () => {
    const fake = execSequence([1]);
    const runner = makeHealthcheckRunner(fake);
    const plan = commandPlan("exit 1", { retries: 3, intervalSeconds: 10, timeoutSeconds: 5 });
    const timed = await runExitUnderClock(runner.run(plan, appId, service), "20 seconds");
    const result = successOf(timed.exit);

    expect(timed.elapsedMs).toBe(20_000);
    expect(result.attempts).toBe(3);

    const earlyFake = execSequence([1]);
    const earlyRunner = makeHealthcheckRunner(earlyFake);
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(earlyRunner.run(plan, appId, service));
        yield* TestClock.adjust("19 seconds");
        const early = yield* Fiber.poll(fiber);
        expect(Option.isNone(early)).toBe(true);
        yield* TestClock.adjust("1 second");
        const result = yield* Fiber.join(fiber);
        expect(result.healthy).toBe(false);
      }).pipe(Effect.provide(TestContext.TestContext)),
    );
  });

  test("green on the third attempt resolves after two fixed delays", async () => {
    const fake = execSequence([1, 1, 0]);
    const timed = await runExitUnderClock(
      makeHealthcheckRunner(fake).run(
        commandPlan(["health"], { retries: 3, intervalSeconds: 10 }),
        appId,
        service,
      ),
      "20 seconds",
    );
    const result = successOf(timed.exit);

    expect(result).toEqual({ healthy: true, service, attempts: 3, lastStatus: "ok" });
    expect(timed.elapsedMs).toBe(20_000);
    expect(fake.calls).toHaveLength(3);
  });

  test("per-attempt timeout fails HealthcheckTimeoutError on exhaustion", async () => {
    const fake = execSleepingExit("30 seconds", 0);
    const timed = await runExitUnderClock(
      makeHealthcheckRunner(fake).run(
        commandPlan("slow", { retries: 2, intervalSeconds: 10, timeoutSeconds: 5 }),
        appId,
        service,
      ),
      "20 seconds",
    );
    const failure = failureOf(timed.exit);

    expect(failure).toBeInstanceOf(HealthcheckTimeoutError);
    expect(timed.elapsedMs).toBe(20_000);
    expect(fake.calls).toHaveLength(2);
    if (failure instanceof HealthcheckTimeoutError) expect(failure.lastStatus).toBe("timeout after 5s");
  });

  test("startPeriodSeconds delays the first exec attempt", async () => {
    const fake = execSequence([0]);
    const runner = makeHealthcheckRunner(fake);

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          runner.run(commandPlan("exit 0", { startPeriodSeconds: 15 }), appId, service),
        );
        yield* TestClock.adjust("14 seconds");
        const early = yield* Fiber.poll(fiber);
        expect(Option.isNone(early)).toBe(true);
        expect(fake.calls).toHaveLength(0);
        yield* TestClock.adjust("1 second");
        const result = yield* Fiber.join(fiber);
        expect(result).toEqual({ healthy: true, service, attempts: 1, lastStatus: "ok" });
        expect(fake.calls).toHaveLength(1);
      }).pipe(Effect.provide(TestContext.TestContext)),
    );
  });

  test("redacts provider and timeout failures when RedactionService is present", async () => {
    const redactedExec = execFailing(`provider saw ${secret}`);
    const redacted = await drive(
      withFakeRedaction(makeHealthcheckRunner(redactedExec).run(commandPlan("fail"), appId, service)),
    );
    expect(redacted.lastStatus).not.toContain(secret);
    expect(redacted.lastStatus).toContain(marker);

    const timeoutExec = execSleepingExit("30 seconds", 0);
    const timed = await runExitUnderClock(
      withFakeRedaction(
        makeHealthcheckRunner(timeoutExec).run(
          commandPlan(`echo ${secret}`, { timeoutSeconds: 5 }),
          appId,
          service,
        ),
      ),
      "5 seconds",
    );
    const timeout = failureOf(timed.exit);
    expect(timeout).toBeInstanceOf(HealthcheckTimeoutError);
    if (timeout instanceof HealthcheckTimeoutError) {
      expect(timeout.message).not.toContain(secret);
      expect(timeout.message).toContain(marker);
      expect(timeout.lastStatus).not.toContain(secret);
      expect(JSON.stringify(timeout.probe)).not.toContain(secret);
      expect(JSON.stringify(timeout.probe)).toContain(marker);
    }

    const rawExec = execFailing(`provider saw ${secret}`);
    const raw = await drive(makeHealthcheckRunner(rawExec).run(commandPlan("fail"), appId, service));
    expect(raw.lastStatus).toContain(secret);
  });

  test("provider failures exhaust as unhealthy results, not timeout failures", async () => {
    const fake = execFailing("provider offline");
    const timed = await runExitUnderClock(
      makeHealthcheckRunner(fake).run(
        commandPlan("fail", { retries: 2, intervalSeconds: 1 }),
        appId,
        service,
      ),
      "1 second",
    );
    const exit = timed.exit;

    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(failureOf(exit)).not.toBeInstanceOf(HealthcheckTimeoutError);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toEqual({ healthy: false, service, attempts: 2, lastStatus: "provider offline" });
      expect(fake.calls).toHaveLength(2);
    }
  });

  test("unsupported probe kinds and missing command fail HealthcheckError", async () => {
    const runner = makeHealthcheckRunner(execSequence([0]));
    const expectHealthcheckError = async (plan: HealthcheckPlan): Promise<void> =>
      expect(failureOf(await driveExit(runner.run(plan, appId, service)))).toBeInstanceOf(HealthcheckError);

    await expectHealthcheckError({
      kind: "http",
      url: "https://example.test",
      intervalSeconds: 1,
      timeoutSeconds: 5,
      retries: 1,
    });
    await expectHealthcheckError({
      kind: "tcp",
      port: 80,
      intervalSeconds: 1,
      timeoutSeconds: 5,
      retries: 1,
    });
    await expectHealthcheckError({ kind: "command", intervalSeconds: 1, timeoutSeconds: 5, retries: 1 });
  });

  test("satisfies the SDK healthcheck runner contract", async () => {
    const runner = makeHealthcheckRunner({ exec: execSequence([0]).exec });
    const exit = await driveExit(runHealthcheckContract(runner));

    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isFailure(exit)) throw new Error(`Contract failure: ${JSON.stringify(failureOf(exit))}`);
  });
});

describe("HealthcheckRunnerLive", () => {
  test("provides the provider-exec runner from RuntimeProvider", async () => {
    const fakeExecOk = execSequence([0]);
    const provider = { ...TestRuntimeProvider, exec: fakeExecOk.exec } satisfies RuntimeProviderShape;
    const runner = await drive(
      Effect.gen(function* () {
        return yield* HealthcheckRunner;
      }).pipe(
        Effect.provide(HealthcheckRunnerLive),
        Effect.provide(Layer.succeed(RuntimeProvider, provider)),
      ),
    );

    expect(runner.id).toBe("provider-exec");
    expect(["unavailable", "disabled"]).not.toContain(runner.id);
    expect(HealthcheckRunnerDefaultLayer).toBe(HealthcheckRunnerLive);
  });
});
