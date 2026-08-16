import { describe, expect, test } from "bun:test";
import { DateTime, Effect, Layer } from "effect";

import { LandofileEventLifecycleReentryError, LandofileEventStepFailedError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppLifecycleEventName,
  type AppPlan,
  PortablePath,
  ProviderId,
} from "@lando/sdk/schema";
import { RuntimeProviderRegistry, ToolingEngine, type ToolingInvocation } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";
import { runAppEvent } from "../../src/operations/events.ts";
import { attachEffectiveEvents } from "../../src/planner/effective-events.ts";
import { attachEffectiveTooling } from "../../src/planner/effective-tooling.ts";
import { EventCommandExecutor } from "../../src/services/event-command-executor.ts";
import { EventServiceLive } from "../../src/services/event-service.ts";

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
  canonical: string[] = [],
  failures: ReadonlySet<string> = new Set(),
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
            stdout: failures.has(label) ? "secret-output" : label,
            stderr: "",
          };
        }),
    }),
    Layer.succeed(EventCommandExecutor, {
      run: (input) =>
        Effect.sync(() => {
          canonical.push(`${input.command}:${input.args.join(",")}`);
          return { exitCode: failures.has(input.command) ? 9 : 0, stdout: input.command, stderr: "" };
        }),
    }),
  );

describe("runAppEvent tooling-step kernel", () => {
  test("runs mixed leaves in authored order and deferred leaves LIFO", async () => {
    // Given
    const invocations: ToolingInvocation[] = [];
    const canonical: string[] = [];
    const plan = attachEffectiveTooling(
      attachEffectiveEvents(eventPlan(), {
        "pre-start": [
          { defer: "cleanup-first" },
          "body",
          { command: "info", args: ["one"], raw: ["two"] },
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
    expect(canonical).toEqual(["info:one,two"]);
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

  test("continues ignored failures and preserves authored index and kind for the next failure", async () => {
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
    expect(invocations).toHaveLength(2);
  });
});
