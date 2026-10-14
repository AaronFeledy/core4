import { describe, expect, test } from "bun:test";
import { Context, DateTime, Effect, Layer, Stream } from "effect";

import { TestRuntimeProvider, makeTestRuntime } from "@lando/core/testing";
import { AbsolutePath, AppId, type AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import { AppPlanner, type RuntimeProviderShape } from "@lando/sdk/services";
import type { BuiltInCommandEntry } from "../../src/cli/built-in-command-registry.ts";
import { execSpec } from "../../src/cli/command-specs/app/exec.ts";
import { sshSpec } from "../../src/cli/command-specs/app/ssh.ts";
import { makeEventCommandExecutor } from "../../src/cli/event-command-executor.ts";

const providerId = ProviderId.make("test");
const serviceName = ServiceName.make("appserver");
const runtimeTag = Context.Service<unknown>("exec-command-spec/runtime");
const plan: AppPlan = {
  id: AppId.make("exec-command-spec"),
  name: "exec-command-spec",
  slug: "exec-command-spec",
  root: AbsolutePath.make("/test-runtime/app"),
  provider: providerId,
  services: {
    [serviceName]: {
      name: serviceName,
      type: "node",
      provider: providerId,
      primary: true,
      environment: {},
      mounts: [],
      storage: [],
      endpoints: [],
      routes: [],
      dependsOn: [],
      hostAliases: [],
      metadata: {
        resolvedAt: DateTime.makeUnsafe("2026-09-11T00:00:00Z"),
        source: "exec-command-spec.test",
        runtime: 4,
      },
      extensions: {},
    },
  },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata: {
    resolvedAt: DateTime.makeUnsafe("2026-09-11T00:00:00Z"),
    source: "exec-command-spec.test",
    runtime: 4,
  },
  extensions: {},
};

describe("exec command spec", () => {
  test.each([
    { command: "ssh", stdinTTY: true, stdoutTTY: false, tty: true },
    { command: "ssh", stdinTTY: false, stdoutTTY: true, tty: false },
    { command: "ssh", stdinTTY: false, stdoutTTY: true, tty: false, format: "json" },
    { command: "exec", stdinTTY: false, stdoutTTY: true, tty: false },
    { command: "exec", stdinTTY: false, stdoutTTY: true, tty: false, format: "json" },
    { command: "exec", stdinTTY: true, stdoutTTY: true, tty: true },
    { command: "exec", stdinTTY: true, stdoutTTY: false, tty: false },
  ])("applies CLI terminal rules for %j", async (scenario) => {
    // Given
    const commands: Array<{
      readonly tty?: boolean;
      readonly stdin?: string;
      readonly env?: Readonly<Record<string, string>>;
    }> = [];
    const provider: RuntimeProviderShape = {
      ...TestRuntimeProvider,
      execStream: (_target, command) => {
        commands.push(command);
        return Stream.fromIterable([{ exitCode: 0 }]);
      },
    };
    const runtime = makeTestRuntime({ bootstrap: "app", with: { RuntimeProvider: provider } });
    const spec = scenario.command === "ssh" ? sshSpec : execSpec;
    const entry: BuiltInCommandEntry = {
      spec: {
        ...spec,
        run: () =>
          spec.run({
            hostIo: "cli",
            parsedArgv: ["cat"],
            flags: { interactive: true, format: scenario.format },
          }),
      },
      status: { kind: "implemented" },
    };
    const stdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const stdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const savedTerm = process.env.TERM;
    const savedColorterm = process.env.COLORTERM;
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: scenario.stdinTTY });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: scenario.stdoutTTY });
    process.env.TERM = "xterm-host";
    process.env.COLORTERM = "truecolor";

    try {
      // When
      await Effect.runPromise(
        Effect.scoped(
          Layer.build(runtime.layer).pipe(
            Effect.map((context) =>
              Context.add(
                Context.add(context, AppPlanner, { plan: () => Effect.succeed(plan) }),
                runtimeTag,
                {},
              ),
            ),
            Effect.flatMap((context) =>
              makeEventCommandExecutor(context, [entry]).run({
                command: spec.id,
                flags: {},
                args: {},
                argv: [],
                cwd: process.cwd(),
              }),
            ),
          ),
        ),
      );
    } finally {
      if (stdinIsTTY === undefined) Reflect.deleteProperty(process.stdin, "isTTY");
      else Object.defineProperty(process.stdin, "isTTY", stdinIsTTY);
      if (stdoutIsTTY === undefined) Reflect.deleteProperty(process.stdout, "isTTY");
      else Object.defineProperty(process.stdout, "isTTY", stdoutIsTTY);
      if (savedTerm === undefined) Reflect.deleteProperty(process.env, "TERM");
      else process.env.TERM = savedTerm;
      if (savedColorterm === undefined) Reflect.deleteProperty(process.env, "COLORTERM");
      else process.env.COLORTERM = savedColorterm;
    }

    // Then
    expect(commands[0]?.tty === true).toBe(scenario.tty);
    expect(commands[0]?.stdin).toBe("inherit");
    if (!scenario.tty) {
      expect(commands[0]?.env ?? {}).not.toHaveProperty("COLUMNS");
      expect(commands[0]?.env ?? {}).not.toHaveProperty("LINES");
    }
    if (!scenario.stdoutTTY) {
      expect(commands[0]?.env ?? {}).not.toHaveProperty("TERM");
      expect(commands[0]?.env ?? {}).not.toHaveProperty("COLORTERM");
    }
  });

  test.each(["explicit non-interactive", "default event", "exec json", "exec yaml", "ssh json", "ssh yaml"])(
    "isolates %s exec on an attached terminal",
    async (mode) => {
      // Given
      const commands: Array<{
        readonly stdin?: "inherit" | "ignore";
        readonly tty?: boolean;
        readonly env?: Readonly<Record<string, string>>;
      }> = [];
      const provider: RuntimeProviderShape = {
        ...TestRuntimeProvider,
        execStream: (_target, command) => {
          commands.push(command);
          return Stream.fromIterable([{ exitCode: 0 }]);
        },
      };
      const runtime = makeTestRuntime({ bootstrap: "app", with: { RuntimeProvider: provider } });
      const stdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
      const stdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
      const savedTerm = process.env.TERM;
      const savedColorterm = process.env.COLORTERM;
      Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
      process.env.TERM = "xterm-host";
      process.env.COLORTERM = "truecolor";

      try {
        // When
        await Effect.runPromise(
          Effect.scoped(
            Layer.build(runtime.layer).pipe(
              Effect.map((context) => Context.add(context, AppPlanner, { plan: () => Effect.succeed(plan) })),
              Effect.flatMap((context) =>
                mode === "default event"
                  ? makeEventCommandExecutor(Context.add(context, runtimeTag, {}), [
                      { spec: execSpec, status: { kind: "implemented" } },
                    ]).run({
                      command: execSpec.id,
                      flags: {},
                      args: { command: "cat" },
                      argv: [],
                      cwd: process.cwd(),
                    })
                  : ((mode.startsWith("ssh") ? sshSpec : execSpec)
                      .run({
                        argv: [],
                        parsedArgv: ["cat"],
                        flags: { interactive: true, format: mode.split(" ")[1] },
                        args: {},
                        ...(mode === "explicit non-interactive" ? { interaction: "non-interactive" } : {}),
                      })
                      .pipe(Effect.provide(context)) as Effect.Effect<unknown, unknown>),
              ),
            ),
          ),
        );
      } finally {
        if (stdinIsTTY === undefined) Reflect.deleteProperty(process.stdin, "isTTY");
        else Object.defineProperty(process.stdin, "isTTY", stdinIsTTY);
        if (stdoutIsTTY === undefined) Reflect.deleteProperty(process.stdout, "isTTY");
        else Object.defineProperty(process.stdout, "isTTY", stdoutIsTTY);
        if (savedTerm === undefined) Reflect.deleteProperty(process.env, "TERM");
        else process.env.TERM = savedTerm;
        if (savedColorterm === undefined) Reflect.deleteProperty(process.env, "COLORTERM");
        else process.env.COLORTERM = savedColorterm;
      }

      // Then
      expect(commands).toHaveLength(1);
      expect(commands[0]?.stdin).toBeUndefined();
      expect(commands[0]?.tty).not.toBe(true);
      expect(commands[0]?.env ?? {}).not.toHaveProperty("TERM");
      expect(commands[0]?.env ?? {}).not.toHaveProperty("COLORTERM");
      expect(commands[0]?.env ?? {}).not.toHaveProperty("COLUMNS");
      expect(commands[0]?.env ?? {}).not.toHaveProperty("LINES");
    },
  );

  test.each([
    { name: "one-shot default", interactive: false, spec: execSpec },
    { name: "explicit interactive event input", interactive: true, spec: execSpec },
    { name: "ssh event input", interactive: true, spec: sshSpec },
  ] as const)("routes $name to provider exec without host stdin", async ({ interactive, spec }) => {
    // Given
    const stdinModes: Array<"inherit" | "ignore" | undefined> = [];
    const provider: RuntimeProviderShape = {
      ...TestRuntimeProvider,
      execStream: (_target, command) => {
        stdinModes.push(command.stdin);
        return Stream.fromIterable([{ exitCode: 0 }]);
      },
    };
    const runtime = makeTestRuntime({ bootstrap: "app", with: { RuntimeProvider: provider } });
    const entry: BuiltInCommandEntry = { spec, status: { kind: "implemented" } };

    // When
    await Effect.runPromise(
      Effect.scoped(
        Layer.build(runtime.layer).pipe(
          Effect.map((context) =>
            Context.add(
              Context.add(context, AppPlanner, { plan: () => Effect.succeed(plan) }),
              runtimeTag,
              {},
            ),
          ),
          Effect.flatMap((context) =>
            makeEventCommandExecutor(context, [entry]).run({
              command: spec.id,
              flags: spec === sshSpec ? {} : { interactive },
              args: { command: "cat" },
              argv: [],
              cwd: process.cwd(),
            }),
          ),
        ),
      ),
    );

    // Then
    expect(stdinModes).toEqual([undefined]);
  });
});
