import { describe, expect, test } from "bun:test";
import { type Context, DateTime, Effect, Layer } from "effect";

import {
  LandofileEventLifecycleReentryError,
  LandofileEventStepFailedError,
  ToolingCommandLookupError,
  ToolingCompileError,
} from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppLifecycleEventName,
  type AppPlan,
  PortablePath,
  ProviderId,
} from "@lando/sdk/schema";
import {
  EventService,
  RuntimeProviderRegistry,
  ShellRunner,
  ToolingEngine,
  type ToolingInvocation,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";
import { runAppEvent } from "../../src/operations/events.ts";
import { attachEffectiveEvents } from "../../src/planner/effective-events.ts";
import { attachEffectiveTooling } from "../../src/planner/effective-tooling.ts";
import {
  EventCommandExecutor,
  type EventCommandExecutorInput,
} from "../../src/services/event-command-executor.ts";
import { EventServiceLive } from "../../src/services/event-service.ts";
import { makeShellRunnerLive } from "../../src/services/shell-runner.ts";

const eventPlan = (): AppPlan => ({
  id: AppId.make("event-reentry"),
  name: "event-reentry",
  slug: "event-reentry",
  root: AbsolutePath.make("/tmp/event-reentry"),
  provider: ProviderId.make("test"),
  services: {},
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata: { resolvedAt: DateTime.unsafeMake("2026-08-16T00:00:00Z"), source: "test", runtime: 4 },
  extensions: {},
});

const runWithFakes = (
  plan: AppPlan,
  event: AppLifecycleEventName,
  enterEvent: AppLifecycleEventName,
  shellRuns: { count: number },
) => {
  const services = Layer.mergeAll(
    EventServiceLive,
    Layer.succeed(RedactionService, {
      forProfile: (profile, options) => Effect.succeed(createStandaloneRedactor(profile, options)),
    }),
    Layer.succeed(RuntimeProviderRegistry, {
      list: Effect.succeed([ProviderId.make("test")]),
      capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
      select: () => Effect.succeed(TestRuntimeProvider),
    }),
    Layer.succeed(ToolingEngine, {
      id: "test",
      run: (invocation) =>
        Effect.sync(() => {
          shellRuns.count += 1;
          return { tool: invocation.tool, service: ":lando", exitCode: 0, stdout: "", stderr: "" };
        }),
    }),
    Layer.succeed(EventCommandExecutor, {
      run: () => runAppEvent(plan, enterEvent).pipe(Effect.as({ exitCode: 0, stdout: "", stderr: "" })),
    }),
  );

  return runAppEvent(plan, event).pipe(Effect.provide(services));
};

describe("runAppEvent lifecycle reentry", () => {
  test("rejects lifecycle reentry before replaying earlier event steps", async () => {
    // Given
    const plan = attachEffectiveEvents(eventPlan(), {
      "pre-start": ["echo earlier", { command: "start" }],
    });
    const shellRuns = { count: 0 };

    // When
    const exit = await Effect.runPromiseExit(runWithFakes(plan, "pre-start", "pre-start", shellRuns));

    // Then
    expect(exit._tag).toBe("Failure");
    expect(shellRuns.count).toBe(1);
  });

  test("names the invoking canonical command in the reentry error", async () => {
    // Given
    const plan = attachEffectiveEvents(eventPlan(), {
      "pre-start": [{ command: "start" }],
    });
    const shellRuns = { count: 0 };

    // When
    const error = await Effect.runPromise(
      Effect.flip(runWithFakes(plan, "pre-start", "pre-start", shellRuns)),
    );

    // Then
    expect(error).toBeInstanceOf(LandofileEventLifecycleReentryError);
    if (error._tag !== "LandofileEventLifecycleReentryError") throw error;
    expect(error.command).toBe("start");
    expect(error.event).toBe("pre-start");
  });

  test("allows a canonical command step to enter a different lifecycle event", async () => {
    // Given
    const plan = attachEffectiveEvents(eventPlan(), {
      "pre-start": [{ command: "stop" }],
      "pre-stop": ["echo nested"],
    });
    const shellRuns = { count: 0 };

    // When
    await Effect.runPromise(runWithFakes(plan, "pre-start", "pre-stop", shellRuns));

    // Then
    expect(shellRuns.count).toBe(1);
  });
});

const eventRuntime = (
  invocations: ToolingInvocation[],
  canonical: EventCommandExecutorInput[] = [],
  failures: ReadonlySet<string> = new Set(),
  canonicalFailure?: ToolingCompileError | ToolingCommandLookupError,
) =>
  Layer.mergeAll(
    EventServiceLive,
    Layer.succeed(RedactionService, {
      forProfile: (profile, options) => Effect.succeed(createStandaloneRedactor(profile, options)),
    }),
    Layer.succeed(RuntimeProviderRegistry, {
      list: Effect.succeed([ProviderId.make("test")]),
      capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
      select: () => Effect.succeed(TestRuntimeProvider),
    }),
    Layer.succeed(ToolingEngine, {
      id: "test",
      run: (invocation) =>
        Effect.sync(() => {
          invocations.push(invocation);
          const label = invocation.commands[0]?.[2] ?? invocation.tool;
          return {
            tool: invocation.tool,
            service: invocation.service ?? ":lando",
            exitCode: failures.has(label) ? 7 : 0,
            stdout: failures.has(label) ? `secret-output${"x".repeat(3_988)}` : label,
            stderr: "",
          };
        }),
    }),
    Layer.succeed(EventCommandExecutor, {
      validate: () => (canonicalFailure === undefined ? Effect.void : Effect.fail(canonicalFailure)),
      run: (input) =>
        canonicalFailure !== undefined
          ? Effect.fail(canonicalFailure)
          : Effect.sync(() => {
              canonical.push(input);
              return { exitCode: failures.has(input.command) ? 9 : 0, stdout: input.command, stderr: "" };
            }),
    }),
  );

const hostShellRunnerLive = makeShellRunnerLive(() => {
  throw new TypeError("Interactive shell IO was not expected in this test.");
});

describe("runAppEvent tooling-step kernel", () => {
  test("preserves the resolved user and working directory on direct command event steps", async () => {
    // Given
    const invocations: ToolingInvocation[] = [];
    const plan = attachEffectiveEvents(eventPlan(), {
      "pre-start": [
        {
          cmd: "whoami",
          service: "appserver",
          user: "www-data",
          dir: PortablePath.make("/workspace/subdir"),
        },
      ],
    });

    // When
    await Effect.runPromise(runAppEvent(plan, "pre-start").pipe(Effect.provide(eventRuntime(invocations))));

    // Then
    expect(invocations).toHaveLength(1);
    expect({ user: invocations[0]?.user, cwd: invocations[0]?.cwd }).toEqual({
      user: "www-data",
      cwd: "/workspace/subdir",
    });
  });

  test("redacts secrets introduced by resolved task variables before live event publication", async () => {
    // Given
    const invocations: ToolingInvocation[] = [];
    const plan = attachEffectiveTooling(
      attachEffectiveEvents(eventPlan(), {
        "pre-start": [{ task: "named", vars: { API_TOKEN: "resolved-secret-value" } }],
      }),
      { named: { cmd: "{{ vars.API_TOKEN }}" } },
    );
    const runtime = eventRuntime(invocations);

    // When
    const details = await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* EventService;
        yield* runAppEvent(plan, "pre-start");
        return yield* events.query("task.detail");
      }).pipe(Effect.provide(runtime)),
    );

    // Then
    const published = JSON.stringify(details);
    expect(published).not.toContain("resolved-secret-value");
    expect(published).toContain("[redacted]");
  });

  test("redacts resolved task variables from host shell lifecycle events", async () => {
    // Given
    const invocations: ToolingInvocation[] = [];
    const secret = "resolved-host-secret";
    const plan = attachEffectiveTooling(
      attachEffectiveEvents(eventPlan(), {
        "pre-start": [{ task: "named", vars: { EVENT_TASK_TOKEN: secret } }],
      }),
      {
        named: {
          cmd: `printf '{{ vars.EVENT_TASK_TOKEN }}'; printf '{{ vars.EVENT_TASK_TOKEN }}' 1>&2; printf ':%s' "\${EVENT_TASK_TOKEN-unset}"`,
          service: ":host",
        },
      },
    );

    // When
    const published = await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* EventService;
        yield* runAppEvent(plan, "pre-start");
        return {
          pre: yield* events.query("pre-shell-exec"),
          post: yield* events.query("post-shell-exec"),
          details: yield* events.query("task.detail"),
        };
      }).pipe(Effect.provide(Layer.mergeAll(eventRuntime(invocations), hostShellRunnerLive))),
    );

    // Then
    expect(published.pre).toHaveLength(1);
    expect(published.post).toHaveLength(1);
    expect(published.details).toHaveLength(2);
    expect(published.pre[0]?.command).toContain("[redacted]");
    expect(published.post[0]?.command).toContain("[redacted]");
    expect(published.post[0]?.stdout).toBe("[redacted]:unset");
    expect(published.post[0]?.stderr).toBe("[redacted]");
    const payload = JSON.stringify(published);
    expect(payload).not.toContain(secret);
    expect(payload).toContain("[redacted]");
    expect(payload).toContain(":unset");
    expect(invocations).toEqual([]);
  });

  test("routes host-targeted event commands through ShellRunner", async () => {
    // Given
    const invocations: ToolingInvocation[] = [];
    const hostCommands: Array<{ readonly command: string; readonly argv?: ReadonlyArray<string> }> = [];
    const plan = attachEffectiveEvents(eventPlan(), {
      "pre-start": [{ cmd: "printf host", service: ":host" }],
    });
    const shell = {
      exec: (command: string, options) =>
        Effect.sync(() => {
          hostCommands.push({ command, ...(options?.argv === undefined ? {} : { argv: options.argv }) });
          return { exitCode: 0, stdout: "host", stderr: "" };
        }),
      run: (command: string) => Effect.succeed({ exitCode: 0, stdout: command, stderr: "" }),
      runScript: (path: string) => Effect.succeed({ exitCode: 0, stdout: path, stderr: "" }),
      interactive: () => Effect.die("unused"),
    } satisfies Context.Tag.Service<typeof ShellRunner>;

    // When
    await Effect.runPromise(
      runAppEvent(plan, "pre-start").pipe(
        Effect.provide(eventRuntime(invocations)),
        Effect.provideService(ShellRunner, shell),
      ),
    );

    // Then
    expect(hostCommands).toEqual([{ command: "printf host", argv: [] }]);
    expect(invocations).toEqual([]);
  });

  test("rejects host shell positional references before execution", async () => {
    // Given
    const invocations: ToolingInvocation[] = [];
    const hostCommands: string[] = [];
    const plan = attachEffectiveEvents(eventPlan(), {
      "pre-start": [{ cmd: 'printf "%s" "$1"', service: ":host" }],
    });
    const shell = {
      exec: (command: string) =>
        Effect.sync(() => {
          hostCommands.push(command);
          return { exitCode: 0, stdout: "", stderr: "" };
        }),
      run: (command: string) => Effect.succeed({ exitCode: 0, stdout: command, stderr: "" }),
      runScript: (path: string) => Effect.succeed({ exitCode: 0, stdout: path, stderr: "" }),
      interactive: () => Effect.die("unused"),
    } satisfies Context.Tag.Service<typeof ShellRunner>;

    // When
    const error = await Effect.runPromise(
      Effect.flip(
        runAppEvent(plan, "pre-start").pipe(
          Effect.provide(eventRuntime(invocations)),
          Effect.provideService(ShellRunner, shell),
        ),
      ),
    );

    // Then
    expect(error).toBeInstanceOf(LandofileEventStepFailedError);
    if (error._tag !== "LandofileEventStepFailedError") throw error;
    expect(error.outputTail).toContain("positional references");
    expect(hostCommands).toEqual([]);
    expect(invocations).toEqual([]);
  });

  test("runs mixed leaves in authored order and deferred leaves LIFO", async () => {
    // Given
    const invocations: ToolingInvocation[] = [];
    const canonical: EventCommandExecutorInput[] = [];
    const plan = attachEffectiveTooling(
      attachEffectiveEvents(eventPlan(), {
        "pre-start": [
          { defer: "cleanup-first" },
          "body",
          { command: "info", args: { target: "one" }, raw: ["two"] },
          { defer: "cleanup-second" },
          { task: "named" },
        ],
      }),
      { named: { cmds: ["named-one", "named-two"] } },
    );

    // When
    await Effect.runPromise(
      runAppEvent(plan, "pre-start").pipe(Effect.provide(eventRuntime(invocations, canonical))),
    );

    // Then
    expect(invocations.map(({ commands }) => commands.map((argv) => argv[2] ?? argv[0]).join("|"))).toEqual([
      'body "$@"',
      'named-one "$@"|named-two "$@"',
      'cleanup-second "$@"',
      'cleanup-first "$@"',
    ]);
    expect(canonical).toHaveLength(1);
    expect(canonical[0]).toMatchObject({ command: "info", args: { target: "one" } });
  });

  test("passes secret-bearing canonical flags as executor redaction tokens", async () => {
    // Given
    const invocations: ToolingInvocation[] = [];
    const canonical: EventCommandExecutorInput[] = [];
    const secret = "canonical-event-secret";
    const plan = attachEffectiveEvents(eventPlan(), {
      "pre-start": [{ command: "info", flags: { API_TOKEN: secret } }],
    });

    // When
    await Effect.runPromise(
      runAppEvent(plan, "pre-start").pipe(Effect.provide(eventRuntime(invocations, canonical))),
    );

    // Then
    const input = canonical[0];
    expect(input !== undefined && "redactionTokens" in input ? input.redactionTokens : undefined).toEqual([
      secret,
    ]);
  });

  test("evaluates for, task vars, and the exact supplied event payload", async () => {
    // Given
    const invocations: ToolingInvocation[] = [];
    const payload = { _tag: "pre-start", nested: { value: "exact" }, sequence: 17 };
    const plan = attachEffectiveTooling(
      attachEffectiveEvents(eventPlan(), {
        "pre-start": [
          { for: ["a", "b"], cmd: "{{ event.nested.value }}-{{ item }}" },
          { task: "named", vars: { selected: "{{ event.sequence }}" } },
        ],
      }),
      {
        named: {
          cmds: ["first-{{ vars.selected }}", "second-{{ vars.selected }}"],
          service: "svc-{{ vars.selected }}",
          dir: PortablePath.make("/tmp/{{ vars.selected }}"),
          env: { VALUE: "{{ vars.selected }}" },
        },
      },
    );

    // When
    await Effect.runPromise(
      runAppEvent(plan, "pre-start", payload).pipe(Effect.provide(eventRuntime(invocations))),
    );

    // Then
    expect(invocations.map(({ service, cwd, env, commands }) => ({ service, cwd, env, commands }))).toEqual([
      {
        service: undefined,
        cwd: undefined,
        env: undefined,
        commands: [["sh", "-c", 'exact-a "$@"', "lando-tooling"]],
      },
      {
        service: undefined,
        cwd: undefined,
        env: undefined,
        commands: [["sh", "-c", 'exact-b "$@"', "lando-tooling"]],
      },
      {
        service: "svc-17",
        cwd: "/tmp/17",
        env: { VALUE: "17" },
        commands: [
          ["sh", "-c", 'first-17 "$@"', "lando-tooling"],
          ["sh", "-c", 'second-17 "$@"', "lando-tooling"],
        ],
      },
    ]);
  });

  test("does not borrow an event-step payload from mutable event history", async () => {
    // Given
    const invocations: ToolingInvocation[] = [];
    const plan = attachEffectiveEvents(eventPlan(), {
      "pre-start": ["echo {{ event.sequence }}"],
    });

    // When
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* EventService;
        yield* events.publish({ _tag: "pre-start", sequence: 99 });
        return yield* Effect.flip(runAppEvent(plan, "pre-start"));
      }).pipe(Effect.provide(eventRuntime(invocations))),
    );

    // Then
    expect(error).toBeInstanceOf(LandofileEventStepFailedError);
    expect(invocations).toEqual([]);
  });

  test("wraps canonical lookup failures with the authored event-step identity", async () => {
    // Given
    const invocations: ToolingInvocation[] = [];
    const plan = attachEffectiveEvents(eventPlan(), {
      "pre-start": ["echo earlier", { command: "missing", args: {} }],
    });
    const lookupFailure = new ToolingCompileError({
      message: "Unknown canonical command missing.",
      tool: "missing",
    });

    // When
    const error = await Effect.runPromise(
      Effect.flip(
        runAppEvent(plan, "pre-start").pipe(
          Effect.provide(eventRuntime(invocations, [], new Set(), lookupFailure)),
        ),
      ),
    );

    // Then
    expect(error).toBeInstanceOf(LandofileEventStepFailedError);
    if (error._tag !== "LandofileEventStepFailedError") throw error;
    expect({ index: error.index, kind: error.kind, outputTail: error.outputTail }).toEqual({
      index: 1,
      kind: "command",
      outputTail: "Unknown canonical command missing.",
    });
  });

  test("preserves lookup detail and remediation in the failure output tail", async () => {
    // Given
    const invocations: ToolingInvocation[] = [];
    const plan = attachEffectiveEvents(eventPlan(), {
      "pre-start": [{ command: "app:confgi", args: {} }],
    });
    const lookupFailure = new ToolingCommandLookupError({
      message: "Unknown canonical command app:confgi.",
      target: "app:confgi",
      targetKind: "built-in",
      remediation: "Did you mean app:config?",
    });

    // When
    const error = await Effect.runPromise(
      Effect.flip(
        runAppEvent(plan, "pre-start").pipe(
          Effect.provide(eventRuntime(invocations, [], new Set(), lookupFailure)),
        ),
      ),
    );

    // Then
    expect(error).toBeInstanceOf(LandofileEventStepFailedError);
    if (error._tag !== "LandofileEventStepFailedError") throw error;
    expect(error.outputTail).toContain("Unknown canonical command app:confgi.");
    expect(error.outputTail).toContain("Did you mean app:config?");
  });

  test("reports the authored identity of a compile failure in the second event step", async () => {
    // Given
    const invocations: ToolingInvocation[] = [];
    const plan = attachEffectiveEvents(eventPlan(), {
      "pre-start": ["echo earlier", { for: { sources: true }, task: "scan" }],
    });

    // When
    const error = await Effect.runPromise(
      Effect.flip(runAppEvent(plan, "pre-start").pipe(Effect.provide(eventRuntime(invocations)))),
    );

    // Then
    expect(error).toBeInstanceOf(LandofileEventStepFailedError);
    if (error._tag !== "LandofileEventStepFailedError") throw error;
    expect({ index: error.index, kind: error.kind }).toEqual({ index: 1, kind: "task" });
  });

  test("rejects an invalid literal canonical input before earlier event steps run", async () => {
    // Given
    const invocations: ToolingInvocation[] = [];
    const plan = attachEffectiveEvents(eventPlan(), {
      "pre-start": ["echo earlier", { command: "app:info", flags: { bogus: true } }],
    });
    const literalFailure = new ToolingCompileError({
      message: "Unknown flag bogus for canonical command app:info.",
      tool: "app:info",
    });

    // When
    await Effect.runPromise(
      Effect.flip(
        runAppEvent(plan, "pre-start").pipe(
          Effect.provide(eventRuntime(invocations, [], new Set(), literalFailure)),
        ),
      ),
    );

    // Then
    expect(invocations).toEqual([]);
  });

  test("rejects an invalid canonical input after its expression resolves and before invocation", async () => {
    // Given
    const invocations: ToolingInvocation[] = [];
    const canonical: EventCommandExecutorInput[] = [];
    const plan = attachEffectiveEvents(eventPlan(), {
      "pre-start": [{ command: "app:info", args: { target: "{{ event.target }}" } }],
    });
    const resolvedFailure = new ToolingCompileError({
      message: "argument target for app:info must be a string.",
      tool: "app:info",
    });

    // When
    const error = await Effect.runPromise(
      Effect.flip(
        runAppEvent(plan, "pre-start", { target: { nested: true } }).pipe(
          Effect.provide(eventRuntime(invocations, canonical, new Set(), resolvedFailure)),
        ),
      ),
    );

    // Then
    expect(error).toBeInstanceOf(LandofileEventStepFailedError);
    expect(canonical).toEqual([]);
    expect(invocations).toEqual([]);
  });

  test("redacts a secret straddling the output-tail cutoff while preserving failure identity", async () => {
    // Given
    const invocations: ToolingInvocation[] = [];
    const plan = attachEffectiveEvents(eventPlan(), {
      "pre-start": [
        { cmd: "ignored", ignoreError: true, silent: true },
        { for: ["x"], cmd: "fatal", env: { SECRET: "secret-output" }, silent: true },
      ],
    });

    // When
    const error = await Effect.runPromise(
      Effect.flip(
        runAppEvent(plan, "pre-start").pipe(
          Effect.provide(eventRuntime(invocations, [], new Set(['ignored "$@"', 'fatal "$@"']))),
        ),
      ),
    );

    // Then
    expect(error).toBeInstanceOf(LandofileEventStepFailedError);
    if (error._tag !== "LandofileEventStepFailedError") throw error;
    expect({ index: error.index, kind: error.kind, exitCode: error.exitCode }).toEqual({
      index: 1,
      kind: "cmd",
      exitCode: 7,
    });
    expect(error.outputTail).not.toContain("secret-output");
    expect(error.outputTail).not.toContain("ecret-output");
    expect(error.outputTail).toContain("[redacted]");
    expect(invocations).toHaveLength(2);
  });

  test("does not publish task detail for a failing silent event step", async () => {
    // Given
    const invocations: ToolingInvocation[] = [];
    const plan = attachEffectiveEvents(eventPlan(), {
      "pre-start": [{ cmd: "quiet-fail", silent: true }],
    });

    // When
    const details = await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* EventService;
        yield* Effect.flip(runAppEvent(plan, "pre-start"));
        return yield* events.query("task.detail");
      }).pipe(Effect.provide(eventRuntime(invocations, [], new Set(['quiet-fail "$@"'])))),
    );

    // Then
    expect(details).toEqual([]);
  });
});
