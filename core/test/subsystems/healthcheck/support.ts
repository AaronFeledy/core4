import { expect } from "bun:test";
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

import { ServiceExecError } from "@lando/sdk/errors";
import { AppId, type HealthcheckPlan, ServiceName } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import type {
  ExecResult,
  ExecTarget,
  CommandSpec as ProviderCommandSpec,
  ProviderError,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { RedactionService, type RedactionServiceShape } from "../../../src/redaction/service.ts";

export type HealthcheckExec = {
  readonly exec: (
    target: ExecTarget,
    command: ProviderCommandSpec,
  ) => Effect.Effect<ExecResult, ProviderError>;
};

export const drive = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(TestContext.TestContext)));

export const driveExit = <A, E>(effect: Effect.Effect<A, E, never>): Promise<Exit.Exit<A, E>> =>
  Effect.runPromiseExit(effect.pipe(Effect.provide(TestContext.TestContext)));

type TimedExit<A, E> = { readonly exit: Exit.Exit<A, E>; readonly elapsedMs: number };

export const runExitUnderClock = <A, E>(
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

export const successOf = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isSuccess(exit)) return exit.value;
  expect(Exit.isSuccess(exit)).toBe(true);
  throw new Error("expected success");
};

export const failureOf = <A, E>(exit: Exit.Exit<A, E>): E => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const failure = Cause.failureOption(exit.cause);
  if (Option.isSome(failure)) return failure.value;
  throw new Error("expected typed failure");
};

export const appId = AppId.make("myapp");
export const service = ServiceName.make("web");

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

export const execSequence = (exitCodes: readonly [number, ...number[]]): FakeExec => {
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

export const execFailing = (message: string): FakeExec =>
  makeExec(() => Effect.fail(providerFailure(message)));

export const execSleepingExit = (sleepFor: Duration.DurationInput, exitCode: number): FakeExec =>
  makeExec(() => Effect.sleep(sleepFor).pipe(Effect.as(execResult(exitCode))));

export const commandPlan = (
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

export const nonePlan = (): HealthcheckPlan => ({
  kind: "none",
  intervalSeconds: 1,
  timeoutSeconds: 5,
  retries: 1,
});

export const secret = "s3cr3t-token";
export const marker = "[REDACTED]";

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

export const withFakeRedaction = <A, E>(effect: Effect.Effect<A, E, never>): Effect.Effect<A, E, never> =>
  effect.pipe(Effect.provide(Layer.succeed(RedactionService, fakeRedactionService)));
