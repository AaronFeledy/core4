import { expect, test } from "bun:test";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { AbsolutePath, AppId, type AppPlan, ProviderId } from "@lando/sdk/schema";
import { EventService, RuntimeProviderRegistry, ToolingEngine } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { DateTime, Effect, Layer } from "effect";
import { withStreamedTail } from "../../src/operations/event-step-output.ts";
import { runAppEvent } from "../../src/operations/events.ts";
import { StreamFrameSink, createCollectingStreamFrameSink } from "../../src/operations/stream-frame-sink.ts";
import { withProjectEvents } from "../../src/planner/effective-events.ts";
import { attachEffectiveTooling } from "../../src/planner/effective-tooling.ts";
import * as EventRuntime from "../../src/services/event-service.ts";
import * as BunProcessRunner from "../../src/services/process-runner.ts";
import { ownerOnlyFileAccess } from "../private-file-access.ts";

for (const kind of ["cmd", "task"] as const) {
  for (const live of [false, true]) {
    test(`${kind} hook output narrates only outside a live sink: live=${live}`, async () => {
      // Given
      const secret = "hook-progress-canary";
      const task = { service: "web", cmd: "hook", env: { API_TOKEN: secret } };
      const basePlan: AppPlan = {
        id: AppId.make("event-output"),
        name: "event-output",
        slug: "event-output",
        root: AbsolutePath.make(process.cwd()),
        provider: ProviderId.make("test"),
        services: {},
        routes: [],
        fileSync: [],
        stores: [],
        extensions: {},
        metadata: { resolvedAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"), source: "test", runtime: 4 },
      };
      const plan = attachEffectiveTooling(
        withProjectEvents(basePlan, { "post-start": [kind === "cmd" ? task : { task: "named" }] }),
        { named: task },
      );
      const payload = createCollectingStreamFrameSink();
      const layer = Layer.mergeAll(
        BunProcessRunner.layer,
        testEnvironmentResolverLayer,
        EventRuntime.layer,
        Layer.succeed(RedactionService, makeRedactionService()),
        Layer.succeed(PrivateFileAccessService, ownerOnlyFileAccess),
        Layer.succeed(RuntimeProviderRegistry, {
          readAppliedPlanStrict: () => Effect.succeed(undefined),
          appliedStateInventory: () => Effect.succeed({ plans: [], unreadable: [] }),
          appliedPlansFor: () => Effect.succeed([]),
          resolveAppliedPlan: () => Effect.succeed(undefined),
          resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
          list: Effect.succeed([plan.provider]),
          capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
          select: () => Effect.succeed(TestRuntimeProvider),
        }),
        Layer.succeed(ToolingEngine, {
          id: "returning-hook",
          run: () =>
            Effect.succeed({
              tool: "hook",
              service: "web",
              exitCode: 0,
              stdout: `line-1\n${secret}\n`,
              stderr: "hook-stderr\n",
            }),
        }),
        live ? Layer.succeed(StreamFrameSink, payload.sink) : Layer.empty,
      );
      // When
      const details = await Effect.runPromise(
        Effect.gen(function* () {
          const events = yield* EventService;
          yield* runAppEvent(plan, "post-start");
          yield* payload.finish();
          return yield* events.query("task.detail");
        }).pipe(Effect.provide(layer)),
      );
      // Then
      expect(details.map((detail) => detail.line)).toEqual(
        live ? [] : ["line-1", "[redacted]", "hook-stderr"],
      );
      expect(payload.result()).toEqual(
        live ? { stdout: `line-1\n${secret}\n`, stderr: "hook-stderr\n" } : { stdout: "", stderr: "" },
      );
    });
  }
}

import { testEnvironmentResolverLayer } from "../environment-values.ts";

const eventFailurePlan = (): AppPlan => {
  const task = { service: "web", cmd: "hook" };
  const basePlan: AppPlan = {
    id: AppId.make("event-failure"),
    name: "event-failure",
    slug: "event-failure",
    root: AbsolutePath.make(process.cwd()),
    provider: ProviderId.make("test"),
    services: {},
    routes: [],
    fileSync: [],
    stores: [],
    extensions: {},
    metadata: { resolvedAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"), source: "test", runtime: 4 },
  };
  return attachEffectiveTooling(withProjectEvents(basePlan, { "post-start": [task] }), {});
};

const eventFailureLayer = (stdout: string, stderr: string, live: boolean) => {
  const plan = eventFailurePlan();
  const payload = createCollectingStreamFrameSink();
  const layer = Layer.mergeAll(
    BunProcessRunner.layer,
    testEnvironmentResolverLayer,
    EventRuntime.layer,
    Layer.succeed(RedactionService, makeRedactionService()),
    Layer.succeed(PrivateFileAccessService, ownerOnlyFileAccess),
    Layer.succeed(RuntimeProviderRegistry, {
      readAppliedPlanStrict: () => Effect.succeed(undefined),
      appliedStateInventory: () => Effect.succeed({ plans: [], unreadable: [] }),
      appliedPlansFor: () => Effect.succeed([]),
      resolveAppliedPlan: () => Effect.succeed(undefined),
      resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
      list: Effect.succeed([plan.provider]),
      capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
      select: () => Effect.succeed(TestRuntimeProvider),
    }),
    Layer.succeed(ToolingEngine, {
      id: "failing-hook",
      run: () =>
        Effect.succeed({
          tool: "hook",
          service: "web",
          exitCode: 1,
          stdout,
          stderr,
        }),
    }),
    live ? Layer.succeed(StreamFrameSink, payload.sink) : Layer.empty,
  );
  return { layer, payload };
};

const multilineStdout = 'password="first\ncanary-multiline-secret\nlast"\n';
const multilineStderr = "Authorization: Bearer\ncanary-bearer-token\n";

test("redacts multi-line narration and the failure tail", async () => {
  // Given output whose credential shapes only complete across lines.
  const { layer } = eventFailureLayer(multilineStdout, multilineStderr, false);

  // When
  const { failure, details } = await Effect.runPromise(
    Effect.gen(function* () {
      const events = yield* EventService;
      const failed = yield* Effect.flip(runAppEvent(eventFailurePlan(), "post-start"));
      return { failure: failed, details: yield* events.query("task.detail") };
    }).pipe(Effect.provide(layer)),
  );

  // Then
  if (failure._tag !== "LandofileEventStepFailedError") throw failure;
  expect(details.map((detail) => detail.line)).toEqual([
    "password=[redacted]",
    "Authorization: Bearer [redacted]",
  ]);
  expect(failure.outputTail).toBe("password=[redacted]\nAuthorization: Bearer [redacted]");
  expect(failure.outputTail).not.toContain("canary");
});

test("derives the live failure tail from safe lines before clipping", async () => {
  // Given the same output delivered through a live sink.
  const { layer } = eventFailureLayer(multilineStdout, multilineStderr, true);

  // When
  const failure = await Effect.runPromise(
    Effect.flip(runAppEvent(eventFailurePlan(), "post-start")).pipe(Effect.provide(layer)),
  );

  // Then
  if (failure._tag !== "LandofileEventStepFailedError") throw failure;
  expect(failure.outputTail).toBe("password=[redacted]\nAuthorization: Bearer [redacted]");
});

test("keeps a credential introducer that precedes the live failure-tail cutoff", async () => {
  // Given an opener far enough back that a raw 4,000-character clip would drop it.
  const padding = "a".repeat(4_200);
  const stdout = `prefix\npassword="${padding}\ncanary-tail\nlast"\n`;
  const { layer } = eventFailureLayer(stdout, "", true);

  // When
  const failure = await Effect.runPromise(
    Effect.flip(runAppEvent(eventFailurePlan(), "post-start")).pipe(Effect.provide(layer)),
  );

  // Then
  if (failure._tag !== "LandofileEventStepFailedError") throw failure;
  expect(failure.outputTail).toBe("prefix\npassword=[redacted]");
});

test("masks a registered multi-line value in collected narration and the failure tail", async () => {
  // Given a registered value that spans a line break in collected output.
  const { layer } = eventFailureLayer("before registered-first\nregistered-second after\n", "", false);

  // When
  const { failure, details } = await Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* RedactionService).registerValues(["registered-first\nregistered-second"]);
      const events = yield* EventService;
      const failed = yield* Effect.flip(runAppEvent(eventFailurePlan(), "post-start"));
      return { failure: failed, details: yield* events.query("task.detail") };
    }).pipe(Effect.provide(layer)),
  );

  // Then
  if (failure._tag !== "LandofileEventStepFailedError") throw failure;
  expect(details.map((detail) => detail.line)).toEqual(["before [redacted] after"]);
  expect(failure.outputTail).toBe("before [redacted] after");
});

test.each(["bytes", "record"] as const)(
  "retains safe %s output across stream fragments and final flush",
  async (kind) => {
    // Given independent streams with a fragmented credential and an unfinished stderr credential.
    const redaction = makeRedactionService();
    const payload = createCollectingStreamFrameSink();
    const chunks =
      kind === "bytes" ? ["pass", 'word="first\n', 'last"\nafter'] : ['password="first', 'last"', "after"];

    // When the live operation emits fragments without returning collected output.
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const redactor = yield* redaction.forProfile("secrets");
        return yield* withStreamedTail(
          redactor,
          Effect.gen(function* () {
            const sink = yield* StreamFrameSink;
            for (const chunk of chunks) yield* sink.emit({ _tag: "stdout", chunk, kind });
            yield* sink.emit({ _tag: "stderr", chunk: 'password="unfinished', kind: "bytes" });
            return {};
          }),
        );
      }).pipe(
        Effect.provideService(RedactionService, redaction),
        Effect.provideService(StreamFrameSink, payload.sink),
      ),
    );

    // Then the tail includes the last public line and flushes each stream independently.
    expect(result.streamedTail).toEqual({
      stdout: "password=[redacted]\nafter",
      stderr: "password=[redacted]",
    });
    expect(payload.result()).toEqual({
      stdout: chunks.join(kind === "record" ? "\n" : "") + (kind === "record" ? "\n" : ""),
      stderr: 'password="unfinished',
    });
  },
);
