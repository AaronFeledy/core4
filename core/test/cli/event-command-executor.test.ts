import { describe, expect, test } from "bun:test";

import { Cause, Context, Effect, Exit, Queue, Schema, Stream } from "effect";

import { RENDERER_CAPABILITIES_NONE } from "@lando/sdk/renderer";
import { EventService, type EventServiceShape, type LandoEvent, Renderer } from "@lando/sdk/services";

import { RuntimeCwd } from "@lando/engine/runtime/cwd";
import { withResolvedCwd } from "@lando/landofile/app-resolution";
import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";
import type { BuiltInCommandEntry } from "../../src/cli/built-in-command-registry.ts";
import { makeNestedCommandInvocation, runCommandLifecycle } from "../../src/cli/command-lifecycle.ts";
import { makeEventCommandExecutor } from "../../src/cli/event-command-executor.ts";
import type { LandoCommandSpec } from "../../src/cli/spec/command-base.ts";
import {
  type ArgDefinitions,
  Args,
  Command,
  type FlagDefinitions,
  Flags,
} from "../../src/cli/spec/metadata.ts";

class EventCommandTestError extends Schema.TaggedError<EventCommandTestError>()("EventCommandTestError", {
  message: Schema.String,
}) {}

interface Harness {
  readonly context: Context.Context<unknown>;
  readonly events: LandoEvent[];
  readonly presentation: string[];
}

const makeHarness = (): Harness => {
  const events: LandoEvent[] = [];
  const presentation: string[] = [];
  const eventService: EventServiceShape = {
    publish: (event) => Effect.sync(() => events.push(event)),
    subscribe: () => Stream.empty,
    subscribeQueue: Effect.gen(function* () {
      const queue = yield* Queue.unbounded<LandoEvent>();
      yield* Effect.addFinalizer(() => Queue.shutdown(queue));
      return queue;
    }),
    waitFor: () => Effect.never,
    waitForAny: () => Effect.never,
    query: () => Effect.succeed([]),
  };
  const renderer = {
    id: "test",
    capabilities: RENDERER_CAPABILITIES_NONE,
    message: {
      info: (body: string) => Effect.sync(() => presentation.push(`info:${body}`)),
      warn: (body: string) => Effect.sync(() => presentation.push(`warn:${body}`)),
      error: (body: string) => Effect.sync(() => presentation.push(`error:${body}`)),
    },
    output: {
      stdout: (chunk: string) => Effect.sync(() => presentation.push(`stdout:${chunk}`)),
      stderr: (chunk: string) => Effect.sync(() => presentation.push(`stderr:${chunk}`)),
    },
  } satisfies Context.Tag.Service<typeof Renderer>;
  const redaction = {
    forProfile: (
      profile: "secrets" | "telemetry" | "transcript",
      options?: Parameters<typeof createStandaloneRedactor>[1],
    ) => Effect.succeed(createStandaloneRedactor(profile, options)),
  } satisfies Context.Tag.Service<typeof RedactionService>;
  return {
    events,
    presentation,
    context: Context.make(Context.GenericTag<unknown>("test/runtime"), {}).pipe(
      Context.add(EventService, eventService),
      Context.add(Renderer, renderer),
      Context.add(RedactionService, redaction),
    ),
  };
};

const entryFor = (
  spec: LandoCommandSpec,
  metadata: {
    readonly flags?: FlagDefinitions;
    readonly args?: ArgDefinitions;
  } = {},
): BuiltInCommandEntry => {
  class TestCommand extends Command {
    static override flags = metadata.flags ?? {};
    static override args = metadata.args ?? {};
    static readonly landoSpec = spec;
    static readonly bootstrap = "none";

    override run(): Promise<void> {
      return Promise.resolve();
    }
  }
  return { command: TestCommand, spec, status: { kind: "implemented" } };
};

const executorFor = (entry: BuiltInCommandEntry, harness: Harness) =>
  makeEventCommandExecutor(harness.context, [entry]);

const testSpec = (run: LandoCommandSpec["run"]): LandoCommandSpec => ({
  id: "meta:test:event-command",
  summary: "Test event command.",
  namespace: "meta",
  bootstrap: "none",
  resultSchema: Schema.Unknown,
  run,
});

describe("EventCommandExecutorLive", () => {
  test("publishes a correlated nested command lifecycle", async () => {
    // Given
    const harness = makeHarness();
    const executor = executorFor(entryFor(testSpec(() => Effect.succeed("done"))), harness);
    const outerInvocation = yieldInvocation("app:start", "/workspace/demo");

    // When
    await Effect.runPromise(
      runCommandLifecycle(
        executor.run({ command: "meta:test:event-command", flags: {}, args: [], cwd: "/workspace/demo" }),
        { invocation: outerInvocation },
      ).pipe(Effect.provide(harness.context)),
    );

    // Then
    const outerInit = harness.events.find((event) => event._tag === "cli-app:start-init");
    const nestedInit = harness.events.find((event) => event._tag === "cli-meta:test:event-command-init");
    expect(nestedInit?.parentInvocationId).toBe(outerInit?.invocationId);
  });

  test("returns and publishes the target success exit code", async () => {
    // Given
    const harness = makeHarness();
    const spec = {
      ...testSpec(() => Effect.succeed({ exitCode: 7 })),
      successExitCode: (result: unknown) =>
        typeof result === "object" &&
        result !== null &&
        "exitCode" in result &&
        typeof result.exitCode === "number"
          ? result.exitCode
          : undefined,
    } satisfies LandoCommandSpec;

    // When
    const result = await Effect.runPromise(
      executorFor(entryFor(spec), harness).run({
        command: spec.id,
        flags: {},
        args: [],
        cwd: "/workspace/demo",
      }),
    );

    // Then
    expect(result.exitCode).toBe(7);
    expect(harness.events.at(-1)).toMatchObject({ _tag: `cli-${spec.id}-run`, exitCode: 7 });
  });

  test("preserves a tagged target failure", async () => {
    // Given
    const harness = makeHarness();
    const executor = executorFor(
      entryFor(testSpec(() => Effect.fail(new EventCommandTestError({ message: "target failed" })))),
      harness,
    );

    // When
    const exit = await Effect.runPromiseExit(
      executor.run({ command: "meta:test:event-command", flags: {}, args: [], cwd: "/workspace/demo" }),
    );

    // Then
    expect(Exit.isFailure(exit)).toBe(true);
    expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined).toBeInstanceOf(EventCommandTestError);
    expect(harness.events.at(-1)).toMatchObject({
      _tag: "cli-meta:test:event-command-error",
      failureTag: "EventCommandTestError",
    });
  });

  test("propagates target interruption", async () => {
    // Given
    const harness = makeHarness();
    const executor = executorFor(entryFor(testSpec(() => Effect.interrupt)), harness);

    // When
    const exit = await Effect.runPromiseExit(
      executor.run({ command: "meta:test:event-command", flags: {}, args: [], cwd: "/workspace/demo" }),
    );

    // Then
    expect(Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause)).toBe(true);
    expect(harness.events.at(-1)).toMatchObject({
      _tag: "cli-meta:test:event-command-error",
      failureTag: "Interrupted",
    });
  });

  test("provides the resolved cwd through RuntimeCwd without changing process cwd", async () => {
    // Given
    const harness = makeHarness();
    const processCwd = process.cwd();
    const observed: Array<{ readonly runtimeCwd: string; readonly processCwd: string }> = [];
    const executor = executorFor(
      entryFor(
        testSpec(() =>
          RuntimeCwd.pipe(
            Effect.tap((runtimeCwd) =>
              Effect.sync(() => observed.push({ runtimeCwd, processCwd: process.cwd() })),
            ),
          ),
        ),
      ),
      harness,
    );

    // When
    await Effect.runPromise(
      executor.run({ command: "meta:test:event-command", flags: {}, args: [], cwd: "/workspace/demo" }),
    );

    // Then
    expect(observed).toEqual([{ runtimeCwd: "/workspace/demo", processCwd }]);
    expect(process.cwd()).toBe(processCwd);
  });

  test("resolves built-in commands from the registry-injected entries", async () => {
    // Given
    const harness = makeHarness();
    const { builtInCommandEntries } = await import("../../src/cli/built-in-command-registry.ts");
    expect(builtInCommandEntries.length).toBeGreaterThan(0);
    const executor = makeEventCommandExecutor(harness.context);

    // When
    const result = await Effect.runPromise(
      executor.run({ command: "meta:version", flags: {}, args: [], cwd: process.cwd() }),
    );

    // Then
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  test("does not deadlock beneath an outer resolved cwd", async () => {
    // Given
    const harness = makeHarness();
    const executor = executorFor(entryFor(testSpec(() => Effect.void)), harness);

    // When
    const result = await Effect.runPromise(
      withResolvedCwd(
        process.cwd(),
        executor.run({ command: "meta:test:event-command", flags: {}, args: [], cwd: process.cwd() }),
      ).pipe(Effect.timeout("250 millis")),
    );

    // Then
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  test("silent suppresses target renderer presentation but preserves lifecycle events", async () => {
    // Given
    const harness = makeHarness();
    const spec = testSpec(() =>
      Renderer.pipe(
        Effect.flatMap((renderer) =>
          Effect.all([renderer.message.info("hidden message"), renderer.output.stdout("hidden output")]),
        ),
      ),
    );

    // When
    await Effect.runPromise(
      executorFor(entryFor(spec), harness).run({
        command: spec.id,
        flags: {},
        args: [],
        cwd: "/workspace/demo",
        silent: true,
      }),
    );

    // Then
    expect(harness.presentation).toEqual([]);
    expect(harness.events.map((event) => event._tag)).toEqual([`cli-${spec.id}-init`, `cli-${spec.id}-run`]);
  });

  test("preserves metadata flag and argument validation", async () => {
    // Given
    const harness = makeHarness();
    const executor = executorFor(
      entryFor(
        testSpec(() => Effect.void),
        {
          flags: { allowed: Flags.boolean() },
          args: { value: Args.string() },
        },
      ),
      harness,
    );

    // When
    const unknownFlag = await Effect.runPromiseExit(
      executor.run({
        command: "meta:test:event-command",
        flags: { bogus: true },
        args: [],
        cwd: process.cwd(),
      }),
    );
    const excessArgs = await Effect.runPromiseExit(
      executor.run({
        command: "meta:test:event-command",
        flags: {},
        args: ["one", "two"],
        cwd: process.cwd(),
      }),
    );

    // Then
    expect(Exit.isFailure(unknownFlag)).toBe(true);
    expect(Exit.isFailure(excessArgs)).toBe(true);
  });
});

const yieldInvocation = (commandId: string, cwd: string) =>
  Effect.runSync(
    makeNestedCommandInvocation(commandId, {
      argv: [commandId],
      args: {},
      flags: {},
      cwd,
    }),
  );
