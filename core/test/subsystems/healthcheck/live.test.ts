import { describe, expect, test } from "bun:test";
import { Effect, Exit, Fiber, Layer, Option, TestClock, TestContext } from "effect";

import { HealthcheckError, HealthcheckTimeoutError } from "@lando/sdk/errors";
import type { HealthcheckPlan } from "@lando/sdk/schema";
import { HealthcheckRunner, RuntimeProvider, type RuntimeProviderShape } from "@lando/sdk/services";
import { TestRuntimeProvider, runHealthcheckContract } from "@lando/sdk/test";

import * as liveModule from "../../../src/subsystems/healthcheck/live.ts";
import {
  appId,
  commandPlan,
  drive,
  driveExit,
  execFailing,
  execSequence,
  execSleepingExit,
  failureOf,
  marker,
  nonePlan,
  runExitUnderClock,
  secret,
  service,
  successOf,
  withFakeRedaction,
} from "./support.ts";

const { HealthcheckRunnerDefaultLayer, HealthcheckRunnerLive, makeHealthcheckRunner } = liveModule;

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

  test("redacts provider and timeout failures", async () => {
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

    const fallbackExec = execFailing("provider saw MY_TOKEN=abc123");
    const fallback = await drive(
      makeHealthcheckRunner(fallbackExec).run(commandPlan("fail"), appId, service),
    );
    expect(fallback.lastStatus).not.toContain("abc123");
    expect(fallback.lastStatus).toContain("[redacted]");
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
