import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { ShellExecError } from "@lando/sdk/errors";
import { AbsolutePath, ContainerUser, ServiceName } from "@lando/sdk/schema";
import { EventService, type LandoEvent } from "@lando/sdk/services";
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Layer, Queue, Result, Stream } from "effect";
import { StreamFrameSink } from "../../../src/operations/stream-frame-sink.ts";
import * as BunProcessRunner from "../../../src/services/process-runner.ts";
import * as BunShellRunner from "../../../src/services/shell-runner.ts";
import { captureHostProbeRunners } from "../../../src/subsystems/healthcheck/attempt.ts";
import { makeHealthcheckRunner } from "../../../src/subsystems/healthcheck/runner-factory.ts";
import { planWith } from "../../services/build-app-runner-test-support.ts";
import { commandPlan, execSequence, runExitUnderClock } from "./support.ts";

const plan = planWith({ web: [] });
const web = ServiceName.make("web");

test("service attempts forward the exact identity and bypass umask wrapping", async () => {
  // Given
  const fake = execSequence([0]);
  const probe = { ...commandPlan(["id", "-u"]), user: ContainerUser.make("1001:1002") };
  // When
  await Effect.runPromise(makeHealthcheckRunner(fake).run(probe, plan.id, web, plan));
  // Then
  expect(fake.calls[0]?.target).toEqual({ app: plan.id, service: web, plan, user: "1001:1002" });
  expect(fake.calls[0]?.command).toMatchObject({ command: ["id", "-u"], raw: true });
});

test("host argv preserves every argument and never invokes provider exec", async () => {
  // Given
  const fake = execSequence([42]);
  const seen: unknown[] = [];
  const command = ["probe", "space value", "$HOME", "; exit 99", ""];
  const runner = makeHealthcheckRunner({
    ...fake,
    runners: {
      process: {
        run: (options) => {
          seen.push(options);
          return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
        },
      },
    },
  });
  // When
  const result = await Effect.runPromise(
    runner.run({ ...commandPlan(command), executionTarget: "host" }, plan.id, web, plan),
  );
  // Then
  expect(result.healthy).toBe(true);
  expect(seen).toEqual([{ cmd: "probe", args: command.slice(1), cwd: plan.root, capture: true }]);
  expect(fake.calls).toHaveLength(0);
});

test("host shell exit failure is normal probe evidence with its real exit and stderr", async () => {
  // Given
  const fake = execSequence([0]);
  const runner = makeHealthcheckRunner({
    ...fake,
    runners: {
      shell: {
        run: () =>
          Effect.fail(
            new ShellExecError({
              command: "exit 23",
              message: "failed",
              exitCode: 23,
              stderr: "not ready",
              remediation: "retry",
            }),
          ),
      },
    },
  });
  // When
  const result = await Effect.runPromise(
    runner.run({ ...commandPlan("exit 23"), executionTarget: "host" }, plan.id, web, plan),
  );
  // Then
  expect(result.healthy).toBe(false);
  expect(result.lastStatus).toContain("exit 23;");
  expect(result.lastStatus).toContain("not ready");
  expect(result.lastStatus).not.toContain("provider");
  expect(fake.calls).toHaveLength(0);
});

test.each(["context", "runner"])("host checks fail closed without %s", async (missing) => {
  // Given
  const fake = execSequence([0]);
  const runner = makeHealthcheckRunner({
    ...fake,
    ...(missing === "runner"
      ? {}
      : { runners: { process: { run: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }) } } }),
  });
  // When
  const result = await Effect.runPromise(
    Effect.result(
      runner.run(
        { ...commandPlan(["true"]), executionTarget: "host" },
        plan.id,
        web,
        missing === "context" ? undefined : plan,
      ),
    ),
  );
  // Then
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) expect(result.failure._tag).toBe("HealthcheckTargetUnsupportedError");
  expect(fake.calls).toHaveLength(0);
});

test("abort interrupts and finalizes a host attempt instead of retrying it", async () => {
  // Given
  const controller = new AbortController();
  const entered = Deferred.makeUnsafe<void>();
  let finalized = false;
  const runner = makeHealthcheckRunner({
    ...execSequence([0]),
    signal: controller.signal,
    runners: {
      process: {
        run: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Effect.sync(() => {
                finalized = true;
              }),
            ),
          ),
      },
    },
  });
  // When
  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        runner.run({ ...commandPlan(["wait"]), executionTarget: "host" }, plan.id, web, plan),
      );
      yield* Deferred.await(entered);
      controller.abort();
      return yield* Fiber.await(fiber);
    }),
  );
  // Then
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
  expect(finalized).toBe(true);
});

test.each(["argv", "shell"])("real host %s runs captured in the app root", async (kind) => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-host-probe-"));
  const fake = execSequence([42]);
  const hostPlan = { ...plan, root: AbsolutePath.make(root) };
  const layers = Layer.merge(
    BunProcessRunner.layer,
    BunShellRunner.layer(() => {
      throw new TypeError("Interactive IO must not be opened");
    }),
  );
  const events: LandoEvent[] = [];
  const frames: unknown[] = [];
  try {
    // When
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runners = yield* captureHostProbeRunners;
        return yield* makeHealthcheckRunner({ ...fake, runners }).run(
          {
            ...commandPlan(
              kind === "argv"
                ? [process.execPath, "-e", "if (process.cwd() !== process.argv[1]) process.exit(31)", root]
                : `test "$(pwd)" = '${root}' && printf captured`,
            ),
            executionTarget: "host",
          },
          plan.id,
          web,
          hostPlan,
        );
      }).pipe(
        Effect.provide(layers),
        Effect.provideService(StreamFrameSink, {
          emit: (frame) =>
            Effect.sync(() => {
              frames.push(frame);
            }),
        }),
        Effect.provideService(RedactionService, makeRedactionService()),
        Effect.provideService(
          EventService,
          EventService.of({
            publish: (event) =>
              Effect.sync(() => {
                events.push(event);
              }),
            subscribe: () => Stream.empty,
            subscribeQueue: Queue.unbounded<never>(),
            waitFor: () => Effect.never,
            waitForAny: () => Effect.never,
            query: () => Effect.succeed([]),
          }),
        ),
      ),
    );
    // Then
    expect(result.healthy).toBe(true);
    expect(fake.calls).toHaveLength(0);
    expect(events).toEqual([]);
    expect(frames).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("host timeout interrupts the attempt and bounds/redacts command evidence", async () => {
  // Given
  const entered = Deferred.makeUnsafe<void>();
  const redaction = makeRedactionService();
  const secret = "host-probe-canary";
  let finalized = 0;
  const runner = makeHealthcheckRunner({
    ...execSequence([0]),
    runners: {
      process: {
        run: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Effect.sync(() => {
                finalized++;
              }),
            ),
          ),
      },
    },
  });
  const work = redaction
    .registerValues([secret])
    .pipe(
      Effect.andThen(
        runner.run(
          { ...commandPlan(["wait", secret, "x".repeat(8192)]), executionTarget: "host", timeoutSeconds: 1 },
          plan.id,
          web,
          plan,
        ),
      ),
      Effect.provideService(RedactionService, redaction),
    );
  // When
  const result = await runExitUnderClock(work, Duration.seconds(1), Deferred.await(entered));
  // Then
  expect(finalized).toBe(1);
  expect(Exit.isFailure(result.exit)).toBe(true);
  if (Exit.isFailure(result.exit)) {
    const error = Cause.findErrorOption(result.exit.cause);
    if (error._tag !== "Some" || error.value._tag !== "HealthcheckTimeoutError")
      throw new TypeError("Expected timeout evidence");
    expect(JSON.stringify(error.value)).not.toContain(secret);
    expect(JSON.stringify(error.value).length).toBeLessThan(4096);
  }
});

test("host retries execute the runner again rather than reusing an earlier attempt", async () => {
  // Given
  let attempts = 0;
  const runner = makeHealthcheckRunner({
    ...execSequence([99]),
    runners: {
      process: { run: () => Effect.succeed({ exitCode: ++attempts === 2 ? 0 : 7, stdout: "", stderr: "" }) },
    },
  });
  // When
  const result = await Effect.runPromise(
    runner.run(
      { ...commandPlan(["ready"]), executionTarget: "host", retries: 2, intervalSeconds: 0 },
      plan.id,
      web,
      plan,
    ),
  );
  // Then
  expect(result.healthy).toBe(true);
  expect(result.attempts).toBe(2);
  expect(attempts).toBe(2);
});
