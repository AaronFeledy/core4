import { describe, expect, test } from "bun:test";
import { Context, Effect, Queue, Schema, Stream } from "effect";

import { PluginContributionGraph } from "@lando/engine/plugins/contribution-graph";
import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";
import type { ExecutableCommandSpec } from "@lando/sdk/plugins";
import { RENDERER_CAPABILITIES_NONE } from "@lando/sdk/renderer";
import { EventService, type EventServiceShape, type LandoEvent, Renderer } from "@lando/sdk/services";
import type { BuiltInCommandEntry } from "../../src/cli/built-in-command-registry.ts";
import { makeEventCommandExecutor } from "../../src/cli/event-command-executor.ts";
import type { LandoCommandSpec } from "../../src/cli/spec/command-spec.ts";
import { Command } from "../../src/cli/spec/metadata.ts";

type Harness = {
  readonly context: Context.Context<unknown>;
  readonly output: string[];
};

const makeHarness = (): Harness => {
  const output: string[] = [];
  const events: EventServiceShape = {
    publish: () => Effect.void,
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
      info: (body: string) => Effect.sync(() => output.push(body)),
      warn: (body: string) => Effect.sync(() => output.push(body)),
      error: (body: string) => Effect.sync(() => output.push(body)),
    },
    output: {
      stdout: (chunk: string) => Effect.sync(() => output.push(chunk)),
      stderr: (chunk: string) => Effect.sync(() => output.push(chunk)),
    },
  } satisfies Context.Tag.Service<typeof Renderer>;
  const redaction = {
    forProfile: (
      profile: "secrets" | "telemetry" | "transcript",
      options?: Parameters<typeof createStandaloneRedactor>[1],
    ) => Effect.succeed(createStandaloneRedactor(profile, options)),
  } satisfies Context.Tag.Service<typeof RedactionService>;
  return {
    output,
    context: Context.make(Context.GenericTag<unknown>("test/runtime"), {}).pipe(
      Context.add(EventService, events),
      Context.add(Renderer, renderer),
      Context.add(RedactionService, redaction),
    ),
  };
};

const withPlugin = (context: Context.Context<unknown>, spec: ExecutableCommandSpec) =>
  Context.add(context, PluginContributionGraph, {
    plugins: [],
    certificateAuthorities: [],
    commands: [
      {
        id: spec.id,
        pluginName: "event-command-regression-plugin",
        source: "explicit",
        load: () => Promise.resolve(spec),
      },
    ],
    hostContext: Context.empty(),
  });

const builtInEntry = (spec: LandoCommandSpec): BuiltInCommandEntry => {
  class TestCommand extends Command {
    static readonly landoSpec = spec;
    static readonly bootstrap = "none";

    override run(): Promise<void> {
      return Promise.resolve();
    }
  }
  return { command: TestCommand, spec, inputSpec: spec, status: { kind: "implemented" } };
};

describe("event command executor regressions", () => {
  test("plugin render receives ordered positional argv and redacted structured input", async () => {
    // Given
    const harness = makeHarness();
    const secrets = {
      flagOne: "flag-secret-one",
      flagTwo: "flag-secret-two",
      firstArg: "argument-secret-first",
      secondArg: "argument-secret-second",
      raw: "raw-argument-secret",
    } as const;
    let parsedArgv: ReadonlyArray<string> = [];
    const spec: ExecutableCommandSpec = {
      id: "example:nested:render",
      summary: "Render a nested command result.",
      namespace: "example",
      bootstrap: "plugins",
      flags: { token: { type: "option", multiple: true } },
      args: { first: { type: "option" }, rest: { type: "option", multiple: true } },
      strict: false,
      resultSchema: Schema.Unknown,
      run: (input) =>
        Effect.sync(() => {
          parsedArgv = input.parsedArgv;
          return input;
        }),
      render: ({ input }) =>
        Renderer.pipe(
          Effect.flatMap((renderer) =>
            renderer.output.stdout(
              JSON.stringify({ flags: input.flags, args: input.args, argv: input.argv }),
            ),
          ),
        ),
    };
    const context = withPlugin(harness.context, spec);

    // When
    const result = await Effect.runPromise(
      makeEventCommandExecutor(context, []).run({
        command: spec.id,
        flags: { token: [secrets.flagOne, secrets.flagTwo] },
        args: { first: secrets.firstArg, rest: [secrets.secondArg] },
        argv: ["--", secrets.raw],
        cwd: process.cwd(),
        redactionTokens: Object.values(secrets),
      }),
    );

    // Then
    expect(harness.output).toHaveLength(1);
    for (const secret of Object.values(secrets)) expect(harness.output[0]).not.toContain(secret);
    expect(harness.output[0]).toContain("[redacted]");
    expect(parsedArgv).toEqual([secrets.firstArg, secrets.secondArg, "--", secrets.raw]);
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  test("silent skips plugin render after successful execution", async () => {
    // Given
    const harness = makeHarness();
    let renderCalls = 0;
    const spec: ExecutableCommandSpec = {
      id: "example:nested:silent",
      summary: "Silence nested rendering.",
      namespace: "example",
      bootstrap: "plugins",
      resultSchema: Schema.Unknown,
      run: () => Effect.void,
      render: () =>
        Effect.sync(() => {
          renderCalls += 1;
        }),
    };

    // When
    await Effect.runPromise(
      makeEventCommandExecutor(withPlugin(harness.context, spec), []).run({
        command: spec.id,
        flags: {},
        args: {},
        argv: [],
        cwd: process.cwd(),
        silent: true,
      }),
    );

    // Then
    expect(renderCalls).toBe(0);
    expect(harness.output).toEqual([]);
  });

  test("built-in render redacts result-derived tokens", async () => {
    // Given
    const harness = makeHarness();
    const secret = "result-derived-secret";
    const spec = {
      id: "meta:test:result-redaction",
      summary: "Redact a result token.",
      namespace: "meta",
      bootstrap: "none",
      resultSchema: Schema.Unknown,
      run: (_input: unknown) => Effect.succeed({ secret }),
      redactionTokens: (result: unknown) =>
        typeof result === "object" && result !== null && "secret" in result ? [String(result.secret)] : [],
      render: (result: unknown) =>
        typeof result === "object" && result !== null && "secret" in result
          ? String(result.secret)
          : undefined,
    } satisfies LandoCommandSpec;

    // When
    await Effect.runPromise(
      makeEventCommandExecutor(harness.context, [builtInEntry(spec)]).run({
        command: spec.id,
        flags: {},
        args: {},
        argv: [],
        cwd: process.cwd(),
      }),
    );

    // Then
    expect(harness.output).toEqual(["[redacted]\n"]);
  });
});
