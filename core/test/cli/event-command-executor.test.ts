import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Cause, Context, DateTime, Effect, Exit, Queue, Schema, Stream } from "effect";

import type { ExecutableCommandSpec } from "@lando/sdk/plugins";
import { RENDERER_CAPABILITIES_NONE } from "@lando/sdk/renderer";
import { AbsolutePath, AppId, type AppPlan, ProviderId } from "@lando/sdk/schema";
import {
  EventService,
  type EventServiceShape,
  type LandoEvent,
  Renderer,
  RuntimeProviderRegistry,
  ShellRunner,
  ToolingEngine,
  type ToolingInvocation,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { runAppEvent } from "@lando/engine/operations/events";
import { attachEffectiveEvents } from "@lando/engine/planner/effective-events";
import { attachEffectiveTooling } from "@lando/engine/planner/effective-tooling";
import { PluginContributionGraph } from "@lando/engine/plugins/contribution-graph";
import { RuntimeCwd } from "@lando/engine/runtime/cwd";
import { EventCommandExecutor } from "@lando/engine/services/event-command-executor";
import { makeShellRunnerService } from "@lando/engine/services/shell-runner";
import { withResolvedCwd } from "@lando/landofile/app-resolution";
import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";
import type { BuiltInCommandEntry } from "../../src/cli/built-in-command-registry.ts";
import { makeNestedCommandInvocation, runCommandLifecycle } from "../../src/cli/command-lifecycle.ts";
import { makeEventCommandExecutor } from "../../src/cli/event-command-executor.ts";
import { validateEventCommandInput } from "../../src/cli/event-command-input.ts";
import type { LandoCommandSpec } from "../../src/cli/spec/command-base.ts";
import { extractSpecParsedArgv } from "../../src/cli/spec/command-boundary.ts";
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
    id: "plain",
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
      Context.add(
        ShellRunner,
        makeShellRunnerService(() => {
          throw new TypeError("Interactive shell IO was not expected in this test.");
        }),
      ),
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
  return {
    command: TestCommand,
    spec: {
      ...spec,
      flags: TestCommand.flags,
      args: TestCommand.args,
      strict: spec.strict ?? TestCommand.strict,
    },
    inputSpec: {
      ...spec,
      flags: TestCommand.flags,
      args: TestCommand.args,
      strict: spec.strict ?? TestCommand.strict,
    },
    status: { kind: "implemented" },
  };
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

const eventPlan = (): AppPlan => ({
  id: AppId.make("nested-event-command"),
  name: "nested-event-command",
  slug: "nested-event-command",
  root: AbsolutePath.make("/workspace/demo"),
  provider: ProviderId.make("test"),
  services: {},
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata: { resolvedAt: DateTime.unsafeMake("2026-08-16T00:00:00Z"), source: "test", runtime: 4 },
  extensions: {},
});

describe("EventCommandExecutorLive", () => {
  test("retains the executor when a canonical command enters another command-backed lifecycle event", async () => {
    // Given
    const harness = makeHarness();
    const plan = attachEffectiveEvents(eventPlan(), {
      "pre-stop": [{ command: "meta:test:second" }],
    });
    let secondRan = false;
    const first = {
      ...testSpec(() => runAppEvent(plan, "pre-stop")),
      id: "meta:test:first",
    } satisfies LandoCommandSpec;
    const second = {
      ...testSpec(() =>
        Effect.sync(() => {
          secondRan = true;
        }),
      ),
      id: "meta:test:second",
    } satisfies LandoCommandSpec;
    const executor = makeEventCommandExecutor(harness.context, [entryFor(first), entryFor(second)]);

    // When
    await Effect.runPromise(
      executor.run({
        command: first.id,
        flags: {},
        args: {},
        argv: [],
        cwd: String(plan.root),
      }),
    );

    // Then
    expect(secondRan).toBe(true);
    const firstInit = harness.events.find((event) => event._tag === "cli-meta:test:first-init");
    const secondInit = harness.events.find((event) => event._tag === "cli-meta:test:second-init");
    expect(secondInit?.parentInvocationId).toBe(firstInit?.invocationId);
  });

  test("publishes a correlated nested command lifecycle", async () => {
    // Given
    const harness = makeHarness();
    const executor = executorFor(entryFor(testSpec(() => Effect.succeed("done"))), harness);
    const outerInvocation = yieldInvocation("app:start", "/workspace/demo");

    // When
    await Effect.runPromise(
      runCommandLifecycle(
        executor.run({
          command: "meta:test:event-command",
          flags: {},
          args: {},
          argv: [],
          cwd: "/workspace/demo",
        }),
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
        args: {},
        argv: [],
        cwd: "/workspace/demo",
      }),
    );

    // Then
    expect(result.exitCode).toBe(7);
    expect(harness.events.at(-1)).toMatchObject({ _tag: `cli-${spec.id}-run`, exitCode: 7 });
  });

  test("renders a successful target result through the provided renderer", async () => {
    // Given
    const harness = makeHarness();
    let renderedInput: unknown;
    const spec = {
      ...testSpec(() => Effect.succeed("done")),
      render: (value, input, ctx) => {
        renderedInput = input;
        return `${String(value)}:${ctx?.mode ?? "missing"}`;
      },
    } satisfies LandoCommandSpec;

    // When
    const result = await Effect.runPromise(
      executorFor(entryFor(spec, { flags: { label: Flags.string() } }), harness).run({
        command: spec.id,
        flags: { label: "rendered" },
        args: {},
        argv: [],
        cwd: "/workspace/demo",
      }),
    );

    // Then
    expect(harness.presentation).toEqual(["stdout:done:plain\n"]);
    expect(renderedInput).toMatchObject({ flags: { label: "rendered" } });
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  test("redacts supplied tokens from canonical host shell lifecycle events", async () => {
    // Given
    const harness = makeHarness();
    const secret = "canonical-host-shell-secret";
    const spec = testSpec(() =>
      ShellRunner.pipe(Effect.flatMap((shell) => shell.exec(`printf '${secret}'`))),
    );
    const input = {
      command: spec.id,
      flags: {},
      args: {},
      argv: [],
      cwd: "/workspace/demo",
      redactionTokens: [secret],
    } as const;

    // When
    await Effect.runPromise(executorFor(entryFor(spec), harness).run(input));

    // Then
    const shellEvents = harness.events.filter(
      (event) => event._tag === "pre-shell-exec" || event._tag === "post-shell-exec",
    );
    const payload = JSON.stringify(shellEvents);
    expect(shellEvents.map((event) => event._tag)).toEqual(["pre-shell-exec", "post-shell-exec"]);
    expect(payload).not.toContain(secret);
    expect(payload).toContain("[redacted]");
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
      executor.run({
        command: "meta:test:event-command",
        flags: {},
        args: {},
        argv: [],
        cwd: "/workspace/demo",
      }),
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
      executor.run({
        command: "meta:test:event-command",
        flags: {},
        args: {},
        argv: [],
        cwd: "/workspace/demo",
      }),
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
      executor.run({
        command: "meta:test:event-command",
        flags: {},
        args: {},
        argv: [],
        cwd: "/workspace/demo",
      }),
    );

    // Then
    expect(observed).toEqual([{ runtimeCwd: "/workspace/demo", processCwd }]);
    expect(process.cwd()).toBe(processCwd);
  });

  test("runs nested app commands inside the resolved app root", async () => {
    // Given
    const harness = makeHarness();
    const appRoot = await mkdtemp(join(tmpdir(), "lando-event-command-root-"));
    let observedCwd = "";
    const spec = {
      ...testSpec(() =>
        Effect.sync(() => {
          observedCwd = process.cwd();
          return "done";
        }),
      ),
      namespace: "app" as const,
      id: "app:test:event-command",
    };

    try {
      // When
      await Effect.runPromise(
        executorFor(entryFor(spec), harness).run({
          command: spec.id,
          flags: {},
          args: {},
          argv: [],
          cwd: appRoot,
        }),
      );

      // Then
      expect(observedCwd).toBe(appRoot);
    } finally {
      await rm(appRoot, { recursive: true, force: true });
    }
  });

  test("resolves built-in commands from the complete canonical registry", async () => {
    // Given
    const harness = makeHarness();
    const { builtInCommandEntries } = await import("../../src/cli/built-in-command-registry.ts");
    expect(builtInCommandEntries.length).toBeGreaterThan(0);
    const executor = makeEventCommandExecutor(harness.context);

    // When
    const result = await Effect.runPromise(
      executor.run({ command: "meta:version", flags: {}, args: {}, argv: [], cwd: process.cwd() }),
    );

    // Then
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  test("runs an app command reentrantly beneath an outer non-current resolved cwd", async () => {
    // Given
    const harness = makeHarness();
    const appRoot = await mkdtemp(join(tmpdir(), "lando-event-command-reentrant-root-"));
    let observedCwd = "";
    const spec = {
      ...testSpec(() =>
        Effect.sync(() => {
          observedCwd = process.cwd();
        }),
      ),
      namespace: "app" as const,
      id: "app:test:event-command",
    };

    try {
      // When
      const result = await Effect.runPromise(
        withResolvedCwd(
          appRoot,
          executorFor(entryFor(spec), harness).run({
            command: spec.id,
            flags: {},
            args: {},
            argv: [],
            cwd: appRoot,
          }),
        ).pipe(Effect.timeout("250 millis")),
      );

      // Then
      expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
      expect(observedCwd).toBe(appRoot);
    } finally {
      await rm(appRoot, { recursive: true, force: true });
    }
  });

  test("silent suppresses target renderer presentation but preserves lifecycle events", async () => {
    // Given
    const harness = makeHarness();
    const spec = {
      ...testSpec(() =>
        Renderer.pipe(
          Effect.flatMap((renderer) =>
            Effect.all([renderer.message.info("hidden message"), renderer.output.stdout("hidden output")]),
          ),
        ),
      ),
      render: () => "hidden rendered result",
    } satisfies LandoCommandSpec;

    // When
    await Effect.runPromise(
      executorFor(entryFor(spec), harness).run({
        command: spec.id,
        flags: {},
        args: {},
        argv: [],
        cwd: "/workspace/demo",
        silent: true,
      }),
    );

    // Then
    expect(harness.presentation).toEqual([]);
    expect(harness.events.map((event) => event._tag)).toEqual([`cli-${spec.id}-init`, `cli-${spec.id}-run`]);
  });

  test("preserves metadata flag validation", async () => {
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
        args: {},
        argv: [],
        cwd: process.cwd(),
      }),
    );
    // Then
    expect(Exit.isFailure(unknownFlag)).toBe(true);
  });

  test("validates required arguments, flag values, and strict raw input", async () => {
    // Given
    const harness = makeHarness();
    const executor = executorFor(
      entryFor(
        testSpec(() => Effect.void),
        {
          flags: {
            count: Flags.integer({ required: true }),
            enabled: Flags.boolean(),
            mode: Flags.string({ options: ["safe", "fast"] }),
          },
          args: { target: Args.string({ required: true }) },
        },
      ),
      harness,
    );

    // When
    const cases = [
      { flags: { count: 1, mode: "safe" }, args: {}, argv: [] },
      { flags: { count: "many", mode: "safe" }, args: { target: "app" }, argv: [] },
      { flags: { count: 1, enabled: "yes", mode: "safe" }, args: { target: "app" }, argv: [] },
      { flags: { count: 1, mode: "unsafe" }, args: { target: "app" }, argv: [] },
      { flags: { count: 1, mode: "safe" }, args: { target: "app" }, argv: ["extra"] },
    ];
    const exits = await Promise.all(
      cases.map((input) =>
        Effect.runPromiseExit(
          executor.run({ command: "meta:test:event-command", ...input, cwd: process.cwd() }),
        ),
      ),
    );

    // Then
    expect(exits.every(Exit.isFailure)).toBe(true);
    expect(
      exits.map((exit) => (Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : "success")),
    ).toEqual([
      expect.stringContaining("Missing required argument target"),
      expect.stringContaining("flag count"),
      expect.stringContaining("flag enabled"),
      expect.stringContaining("must be one of"),
      expect.stringContaining("does not accept raw arguments"),
    ]);
  });

  test("discovers and executes a plugin command loader from the production graph", async () => {
    // Given
    const harness = makeHarness();
    let ran = false;
    const manifest = Schema.decodeSync((await import("@lando/sdk/schema")).PluginManifest)({
      name: "@example/commands",
      version: "1.0.0",
      api: 4,
      contributes: { commands: ["meta:example:hello"] },
    });
    const module = {
      name: manifest.name,
      manifest,
      commands: new Map([
        [
          "meta:example:hello",
          async () => ({
            id: "meta:example:hello",
            summary: "Hello from a plugin.",
            namespace: "meta" as const,
            bootstrap: "plugins" as const,
            resultSchema: Schema.Unknown,
            run: () =>
              Effect.sync(() => {
                ran = true;
              }),
          }),
        ],
      ]),
    };
    const context = Context.add(harness.context, PluginContributionGraph, {
      plugins: [{ source: "explicit", manifest, entry: module, module }],
      certificateAuthorities: [],
      commands: [
        {
          id: "meta:example:hello",
          pluginName: String(manifest.name),
          source: "explicit",
          load:
            module.commands.get("meta:example:hello") ??
            (() => Promise.reject(new TypeError("missing loader"))),
        },
      ],
      hostContext: Context.empty(),
    });

    // When
    await Effect.runPromise(
      makeEventCommandExecutor(context).run({
        command: "meta:example:hello",
        flags: {},
        args: {},
        argv: [],
        cwd: process.cwd(),
      }),
    );

    // Then
    expect(ran).toBe(true);
    expect(harness.events.map((event) => event._tag)).toEqual([
      "cli-meta:example:hello-init",
      "cli-meta:example:hello-run",
    ]);
  });

  test("executes an effective tooling canonical id through ToolingEngine", async () => {
    // Given
    const harness = makeHarness();
    const plan = attachEffectiveTooling(
      { ...eventPlan(), root: AbsolutePath.make(process.cwd()) },
      { lint: { cmd: "bun run lint" } },
    );
    const invocations: string[] = [];
    const context = harness.context.pipe(
      Context.add(RuntimeProviderRegistry, {
        list: Effect.succeed([ProviderId.make("test")]),
        capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
        select: () => Effect.succeed(TestRuntimeProvider),
      }),
      Context.add(ToolingEngine, {
        id: "test",
        run: (invocation) =>
          Effect.sync(() => {
            invocations.push(invocation.tool);
            return {
              tool: invocation.tool,
              service: ":lando",
              exitCode: 0,
              stdout: "tooling stdout",
              stderr: "tooling stderr",
            };
          }),
      }),
    );
    const input = {
      command: "app:lint",
      flags: {},
      args: {},
      argv: [],
      cwd: process.cwd(),
      plan,
    };

    // When
    const result = await Effect.runPromise(makeEventCommandExecutor(context).run(input));

    // Then
    expect(invocations).toEqual(["lint"]);
    expect(result).toEqual({ exitCode: 0, stdout: "tooling stdout", stderr: "tooling stderr" });
    expect(harness.presentation).toEqual([]);
  });

  test("redacts flag-shaped raw argv from nested lifecycle events without changing target argv", async () => {
    // Given
    const harness = makeHarness();
    const secret = "--US565-RAW-SECRET";
    const invocations: ToolingInvocation[] = [];
    const plan = attachEffectiveTooling(
      attachEffectiveEvents(
        { ...eventPlan(), root: AbsolutePath.make(process.cwd()) },
        { "pre-start": [{ command: "app:inspect", raw: [secret] }] },
      ),
      { inspect: { cmd: "inspect" } },
    );
    const context = harness.context.pipe(
      Context.add(RuntimeProviderRegistry, {
        list: Effect.succeed([ProviderId.make("test")]),
        capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
        select: () => Effect.succeed(TestRuntimeProvider),
      }),
      Context.add(ToolingEngine, {
        id: "test",
        run: (invocation) =>
          Effect.sync(() => {
            invocations.push(invocation);
            return { tool: invocation.tool, service: ":lando", exitCode: 0, stdout: "", stderr: "" };
          }),
      }),
    );
    const executor = makeEventCommandExecutor(context);
    const runtime = Context.add(context, EventCommandExecutor, executor);

    // When
    await Effect.runPromise(runAppEvent(plan, "pre-start").pipe(Effect.provide(runtime)));

    // Then
    expect(invocations[0]?.commands[0]).toContain(secret);
    const lifecycle = harness.events.filter(
      (event) => event._tag === "cli-app:inspect-init" || event._tag === "cli-app:inspect-run",
    );
    expect(lifecycle).toHaveLength(2);
    const payload = JSON.stringify(lifecycle);
    expect(payload).not.toContain(secret);
    expect(payload).toContain("[redacted]");
    expect(harness.presentation).toEqual([]);
  });

  test("redacts canonical tooling env secrets from detail and nonzero failure output", async () => {
    // Given
    const harness = makeHarness();
    const secret = "US565-TOOLING-ENV-SECRET";
    const plan = attachEffectiveTooling(
      attachEffectiveEvents(
        { ...eventPlan(), root: AbsolutePath.make(process.cwd()) },
        { "pre-start": [{ command: "app:inspect" }] },
      ),
      { inspect: { cmd: "inspect", env: { API_TOKEN: secret } } },
    );
    const context = harness.context.pipe(
      Context.add(RuntimeProviderRegistry, {
        list: Effect.succeed([ProviderId.make("test")]),
        capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
        select: () => Effect.succeed(TestRuntimeProvider),
      }),
      Context.add(ToolingEngine, {
        id: "test",
        run: (invocation) => {
          const token = invocation.env?.API_TOKEN ?? "missing";
          return Effect.succeed({
            tool: invocation.tool,
            service: ":lando",
            exitCode: 7,
            stdout: `stdout:${token}`,
            stderr: `stderr:${token}`,
          });
        },
      }),
    );
    const executor = makeEventCommandExecutor(context);
    const runtime = Context.add(context, EventCommandExecutor, executor);

    // When
    const error = await Effect.runPromise(
      Effect.flip(runAppEvent(plan, "pre-start").pipe(Effect.provide(runtime))),
    );

    // Then
    expect(error).toMatchObject({ _tag: "LandofileEventStepFailedError", exitCode: 7 });
    if (error._tag !== "LandofileEventStepFailedError") throw error;
    expect(error.outputTail).toBe("stdout:[redacted]\nstderr:[redacted]");
    const details = harness.events.filter((event) => event._tag === "task.detail");
    expect(details).toHaveLength(2);
    const payload = JSON.stringify(details);
    expect(payload).not.toContain(secret);
    expect(payload).toContain("[redacted]");
    expect(harness.presentation).toEqual([]);
  });

  test("rejects an unknown built-in canonical id with a tagged lookup error naming close matches", async () => {
    // Given
    const harness = makeHarness();
    const executor = executorFor(entryFor(testSpec(() => Effect.void)), harness);

    // When
    const missing = await Effect.runPromiseExit(
      executor.run({
        command: "meta:test:event-commnd",
        flags: {},
        args: {},
        argv: [],
        cwd: process.cwd(),
      }),
    );

    // Then
    expect(Exit.isFailure(missing)).toBe(true);
    expect(Exit.isFailure(missing) ? Cause.squash(missing.cause) : undefined).toMatchObject({
      _tag: "ToolingCommandLookupError",
      target: "meta:test:event-commnd",
      targetKind: "built-in",
      remediation: expect.stringContaining("meta:test:event-command"),
    });
  });

  test("reports an unknown tooling canonical id against the effective tooling registry", async () => {
    // Given
    const harness = makeHarness();
    const plan = attachEffectiveTooling(
      { ...eventPlan(), root: AbsolutePath.make(process.cwd()) },
      { lint: { cmd: "bun run lint" } },
    );

    // When
    const missing = await Effect.runPromiseExit(
      makeEventCommandExecutor(harness.context, []).run({
        command: "app:lnt",
        flags: {},
        args: {},
        argv: [],
        cwd: process.cwd(),
        plan,
      }),
    );

    // Then
    expect(Exit.isFailure(missing)).toBe(true);
    expect(Exit.isFailure(missing) ? Cause.squash(missing.cause) : undefined).toMatchObject({
      _tag: "ToolingCommandLookupError",
      target: "app:lnt",
      targetKind: "tooling",
      remediation: expect.stringContaining("app:lint"),
    });
  });

  test("rejects a bare tooling name because command steps accept canonical ids only", async () => {
    // Given
    const harness = makeHarness();
    const plan = attachEffectiveTooling(
      { ...eventPlan(), root: AbsolutePath.make(process.cwd()) },
      { lint: { cmd: "bun run lint" } },
    );

    // When
    const bare = await Effect.runPromiseExit(
      makeEventCommandExecutor(harness.context, []).run({
        command: "lint",
        flags: {},
        args: {},
        argv: [],
        cwd: process.cwd(),
        plan,
      }),
    );

    // Then
    expect(Exit.isFailure(bare)).toBe(true);
    expect(Exit.isFailure(bare) ? Cause.squash(bare.cause) : undefined).toMatchObject({
      _tag: "ToolingCommandLookupError",
      target: "lint",
    });
  });

  test("rejects an unknown named canonical command argument", async () => {
    // Given
    const harness = makeHarness();
    const executor = executorFor(
      entryFor(
        testSpec(() => Effect.void),
        { args: { value: Args.string() } },
      ),
      harness,
    );

    // When
    const unknownArg = await Effect.runPromiseExit(
      executor.run({
        command: "meta:test:event-command",
        flags: {},
        args: { bogus: "value" },
        argv: [],
        cwd: process.cwd(),
      }),
    );

    // Then
    expect(Exit.isFailure(unknownArg)).toBe(true);
    expect(Exit.isFailure(unknownArg) ? Cause.squash(unknownArg.cause) : undefined).toMatchObject({
      _tag: "CommandInputValidationError",
      target: "meta:test:event-command",
      field: "bogus",
      kind: "arg",
      reason: "unknown",
    });
  });

  test("rejects deferred canonical commands with the structured not-implemented error", async () => {
    // Given
    const harness = makeHarness();
    const deferred = {
      summary: "Deferred test command.",
      remediation: "Use an implemented command.",
      phase: "4.1" as const,
    };
    const spec: LandoCommandSpec = {
      ...testSpec(() => Effect.die("deferred command must not run")),
      deferred,
    };
    const entry: BuiltInCommandEntry = {
      ...entryFor(spec),
      status: { kind: "deferred", plan: deferred },
    };

    // When
    const executor = executorFor(entry, harness);
    const input = {
      command: spec.id,
      flags: {},
      args: {},
      argv: [],
      cwd: process.cwd(),
    };
    const validationError = await Effect.runPromise(Effect.flip(executor.validate?.(input) ?? Effect.void));
    const runError = await Effect.runPromise(Effect.flip(executor.run(input)));

    // Then
    expect(validationError).toMatchObject({ _tag: "NotImplementedError", commandId: spec.id });
    expect(runError).toMatchObject({ _tag: "NotImplementedError", commandId: spec.id });
  });

  test("keeps canonical arguments structured and exposes raw argv as parsedArgv", async () => {
    // Given
    const harness = makeHarness();
    let captured:
      | { readonly parsedArgv: ReadonlyArray<string>; readonly args: Record<string, unknown> }
      | undefined;
    const spec = {
      ...testSpec((input) =>
        Effect.sync(() => {
          if (typeof input === "object" && input !== null && "argv" in input && "args" in input) {
            captured = {
              parsedArgv: extractSpecParsedArgv(input),
              args:
                typeof input.args === "object" && input.args !== null
                  ? Object.fromEntries(Object.entries(input.args))
                  : {},
            };
          }
          return "done";
        }),
      ),
      strict: false,
    } satisfies LandoCommandSpec;
    const executor = executorFor(entryFor(spec, { args: { target: Args.string() } }), harness);

    // When
    await Effect.runPromise(
      executor.run({
        command: "meta:test:event-command",
        flags: {},
        args: { target: "named" },
        argv: ["--", "raw", "tail"],
        cwd: "/workspace/demo",
      }),
    );

    // Then
    expect(captured).toEqual({ args: { target: "named" }, parsedArgv: ["named", "--", "raw", "tail"] });
  });

  test("parses every occurrence of a multiple canonical flag in order", async () => {
    // Given
    const harness = makeHarness();
    let captured: unknown;
    const spec = testSpec((input) =>
      Effect.sync(() => {
        captured = input;
      }),
    );
    const executor = executorFor(
      entryFor(spec, {
        flags: {
          label: Flags.string({
            multiple: true,
            parse: async (value) => value.toUpperCase(),
          }),
        },
      }),
      harness,
    );

    // When
    await Effect.runPromise(
      executor.run({
        command: spec.id,
        flags: { label: ["first", "second"] },
        args: {},
        argv: [],
        cwd: process.cwd(),
      }),
    );

    // Then
    expect(captured).toMatchObject({ flags: { label: ["FIRST", "SECOND"] } });
  });

  test("normalizes all primitive command input kinds and preserves declaration order", async () => {
    // Given
    const spec = {
      id: "meta:test:parser",
      summary: "Parser fixture.",
      namespace: "meta",
      bootstrap: "none",
      strict: false,
      flags: {
        decimal: { type: "number" },
        integer: { type: "option", valueType: "integer" },
        enabled: { type: "boolean" },
        mode: { type: "option", options: ["SAFE", "FAST"], parse: (value) => value.toUpperCase() },
        labels: { type: "option", multiple: true, parse: async (value) => `[${value}]` },
      },
      args: {
        target: { type: "option" },
        paths: { type: "option", multiple: true },
      },
      resultSchema: Schema.Unknown,
      run: () => Effect.void,
    } satisfies ExecutableCommandSpec;

    // When
    const input = await Effect.runPromise(
      validateEventCommandInput(spec, {
        flags: { labels: ["one", "two"], mode: "safe", enabled: false, integer: 4, decimal: 1.25 },
        args: { paths: ["a", "b"], target: "app" },
        raw: ["--", "tail"],
      }),
    );

    // Then
    expect(input).toEqual({
      argv: ["--", "tail"],
      parsedArgv: ["app", "a", "b", "--", "tail"],
      flags: { decimal: 1.25, integer: 4, enabled: false, mode: "SAFE", labels: ["[one]", "[two]"] },
      args: { target: "app", paths: ["a", "b"] },
    });
    expect(Object.keys(input.flags)).toEqual(["decimal", "integer", "enabled", "mode", "labels"]);
    expect(Object.keys(input.args)).toEqual(["target", "paths"]);
    expect(Object.getPrototypeOf(input.flags)).toBeNull();
    expect(Object.getPrototypeOf(input.args)).toBeNull();
  });

  test("uses defaults only when a command input field is absent", async () => {
    // Given
    const spec = {
      id: "meta:test:defaults",
      summary: "Default fixture.",
      namespace: "meta",
      bootstrap: "none",
      flags: {
        enabled: { type: "boolean", default: false },
        retries: { type: "option", valueType: "integer", default: 0 },
        label: { type: "option", default: "" },
      },
      resultSchema: Schema.Unknown,
      run: () => Effect.void,
    } satisfies ExecutableCommandSpec;

    // When
    const input = await Effect.runPromise(validateEventCommandInput(spec, { flags: {}, args: {}, raw: [] }));

    // Then
    expect(input.flags).toEqual({ enabled: false, retries: 0, label: "" });
  });

  test("rejects an explicitly undefined field instead of replacing it with its default", async () => {
    // Given
    const spec = {
      id: "meta:test:defaults",
      summary: "Default fixture.",
      namespace: "meta",
      bootstrap: "none",
      flags: { enabled: { type: "boolean", default: true } },
      resultSchema: Schema.Unknown,
      run: () => Effect.void,
    } satisfies ExecutableCommandSpec;

    // When
    const error = await Effect.runPromise(
      Effect.flip(validateEventCommandInput(spec, { flags: { enabled: undefined }, args: {}, raw: [] })),
    );

    // Then
    expect(error).toMatchObject({
      _tag: "CommandInputValidationError",
      target: spec.id,
      field: "enabled",
      kind: "flag",
      reason: "type",
    });
  });

  test("rejects non-finite, fractional integer, loose boolean, cardinality, option, and parser failures", async () => {
    // Given
    const rejectingParser = new EventCommandTestError({ message: "parser rejected value" });
    const spec = {
      id: "meta:test:invalid-input",
      summary: "Invalid input fixture.",
      namespace: "meta",
      bootstrap: "none",
      flags: {
        decimal: { type: "number" },
        integer: { type: "option", valueType: "integer" },
        enabled: { type: "boolean" },
        mode: { type: "option", options: ["safe"] },
        single: { type: "option" },
        multiple: { type: "option", multiple: true },
        parsed: {
          type: "option",
          parse: async () => Promise.reject(rejectingParser),
        },
      },
      resultSchema: Schema.Unknown,
      run: () => Effect.void,
    } satisfies ExecutableCommandSpec;
    const cases = [
      { field: "decimal", value: Number.NaN, reason: "type" },
      { field: "decimal", value: Number.POSITIVE_INFINITY, reason: "type" },
      { field: "integer", value: 1.5, reason: "type" },
      { field: "enabled", value: "true", reason: "type" },
      { field: "mode", value: "fast", reason: "option" },
      { field: "single", value: ["one"], reason: "type" },
      { field: "multiple", value: "one", reason: "type" },
      { field: "parsed", value: "bad", reason: "parse" },
    ] as const;

    // When
    const errors = await Promise.all(
      cases.map(({ field, value }) =>
        Effect.runPromise(
          Effect.flip(validateEventCommandInput(spec, { flags: { [field]: value }, args: {}, raw: [] })),
        ),
      ),
    );

    // Then
    expect(errors.map(({ field, reason, cause }) => ({ field, reason, cause }))).toEqual(
      cases.map(({ field, reason }) => ({
        field,
        reason,
        ...(field === "parsed" ? { cause: rejectingParser } : { cause: undefined }),
      })),
    );
  });

  test("rejects own keys that exist only on Object.prototype", async () => {
    // Given
    const spec = {
      id: "meta:test:prototype",
      summary: "Prototype fixture.",
      namespace: "meta",
      bootstrap: "none",
      flags: {},
      resultSchema: Schema.Unknown,
      run: () => Effect.void,
    } satisfies ExecutableCommandSpec;
    const flags = Object.assign(Object.create(null), { toString: "owned" });

    // When
    const error = await Effect.runPromise(
      Effect.flip(validateEventCommandInput(spec, { flags, args: {}, raw: [] })),
    );

    // Then
    expect(error).toMatchObject({ field: "toString", kind: "flag", reason: "unknown" });
  });

  test("ignores inherited input keys", async () => {
    // Given
    const spec = {
      id: "meta:test:prototype",
      summary: "Prototype fixture.",
      namespace: "meta",
      bootstrap: "none",
      flags: { label: { type: "option", required: true } },
      resultSchema: Schema.Unknown,
      run: () => Effect.void,
    } satisfies ExecutableCommandSpec;
    const flags = Object.create({ inherited: "ignored" });
    Object.defineProperty(flags, "label", { value: "owned", enumerable: true });

    // When
    const input = await Effect.runPromise(validateEventCommandInput(spec, { flags, args: {}, raw: [] }));

    // Then
    expect(input.flags).toEqual({ label: "owned" });
    expect(Object.hasOwn(input.flags, "inherited")).toBe(false);
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
