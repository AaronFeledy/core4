import { expect, test } from "bun:test";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  GlobalConfig,
  PortablePath,
  ProviderId,
  ServiceName,
  type ToolingTaskShape,
} from "@lando/sdk/schema";
import {
  AppPlanner,
  type CommandSpec,
  ConfigService,
  type ExecTarget,
  LandofileService,
  RuntimeProviderRegistry,
  ShellRunner,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { PrivateFileAccessLive } from "@lando/state-store/private-file-access";
import { DateTime, Effect, Either, Layer, Schema, Stream } from "effect";
import { type RunToolingOptions, runTooling } from "../../src/operations/tooling.ts";
import { attachEffectiveTooling } from "../../src/planner/effective-tooling.ts";
import { ProviderExecToolingEngineLive } from "../../src/services/tooling-engine.ts";

const fixture = (task: ToolingTaskShape, failureCode = 0) => {
  const calls: {
    readonly service: string;
    readonly command: readonly string[];
    readonly user?: string;
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string>>;
  }[] = [];
  const selections: number[] = [];
  const metadata = {
    resolvedAt: DateTime.unsafeMake("2026-05-18T00:00:00Z"),
    source: "tooling.test",
    runtime: 4 as const,
  };
  const service = {
    name: ServiceName.make("worker"),
    type: "node",
    provider: ProviderId.make("test"),
    primary: true,
    environment: {},
    mounts: [],
    storage: [],
    endpoints: [],
    routes: [],
    dependsOn: [],
    hostAliases: [],
    metadata,
    extensions: {},
  };
  const plan: AppPlan = {
    id: AppId.make("tooling-test"),
    name: "tooling-test",
    slug: "tooling-test",
    root: AbsolutePath.make(process.cwd()),
    provider: service.provider,
    services: { [service.name]: service },
    routes: [],
    networks: [],
    fileSync: [],
    stores: [],
    metadata,
    extensions: {},
  };
  const provider = {
    ...TestRuntimeProvider,
    execStream: (target: ExecTarget, spec: CommandSpec) => {
      calls.push({
        service: String(target.service),
        command: spec.command,
        ...(target.user === undefined ? {} : { user: target.user }),
        ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
        ...(spec.env === undefined ? {} : { env: spec.env }),
      });
      return Stream.make({ exitCode: failureCode });
    },
  };
  const config = Schema.decodeUnknownSync(GlobalConfig)({});
  const layer = Layer.mergeAll(
    PrivateFileAccessLive,
    ProviderExecToolingEngineLive,
    Layer.succeed(LandofileService, {
      discover: Effect.succeed({ name: "tooling-test", tooling: { custom: task } }),
    }),
    Layer.succeed(AppPlanner, { plan: () => Effect.succeed(plan) }),
    Layer.succeed(ConfigService, { load: Effect.succeed(config), get: (key) => Effect.succeed(config[key]) }),
    Layer.succeed(RuntimeProviderRegistry, {
      list: Effect.succeed([service.provider]),
      capabilities: Effect.succeed(provider.capabilities),
      select: () =>
        Effect.sync(() => {
          selections.push(1);
          return provider;
        }),
    }),
    Layer.succeed(ShellRunner, {
      exec: (source, options) =>
        Effect.sync(() => {
          calls.push({
            service: ":host",
            command: [source, ...(options?.argv ?? [])],
            ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
            ...(options?.env === undefined ? {} : { env: options.env }),
          });
          return { exitCode: failureCode, stdout: "", stderr: "" };
        }),
      runScript: () => Effect.die("unused script"),
      run: () => Effect.die("unused run"),
      interactive: () => Effect.die("unused interactive"),
    }),
  );
  return {
    calls,
    selections,
    plan,
    run: (options: Omit<RunToolingOptions, "name"> = {}) =>
      Effect.runPromise(
        runTooling({ name: "custom", ...options }).pipe(Effect.provide(layer), Effect.either),
      ),
  };
};

test("rejects a freshly disabled task even when the plan carries an enabled task", async () => {
  // Given an enabled cached plan and a freshly loaded disabled declaration
  const f = fixture({ cmd: "echo ok", disabled: true });
  attachEffectiveTooling(f.plan, { custom: { cmd: "echo stale" } });
  // When invoked
  const result = await f.run();
  // Then the fresh declaration is authoritative
  expect(result).toMatchObject({
    _tag: "Left",
    left: { _tag: "ToolingDisabledError", tool: "custom", source: { task: "custom" } },
  });
  expect(f.selections).toHaveLength(0);
});

test.each(["echo", ["echo", "literal value"]])("forwards undeclared argv unchanged for %j", async (cmd) => {
  // Given no declared inputs
  const f = fixture({ cmd });
  const args = ["--bogus", "a b", "", "--", "$literal"];
  // When invoked
  const result = await f.run({ args });
  // Then raw tokens reach the provider
  expect(Either.isRight(result)).toBe(true);
  expect(f.calls[0]?.command.slice(-args.length)).toEqual(args);
});

const invalidInputs: readonly {
  readonly task: ToolingTaskShape;
  readonly args: readonly string[];
  readonly field: string;
}[] = [
  { task: { cmd: "echo", flags: { verbose: { boolean: true } } }, args: ["--bogus"], field: "bogus" },
  { task: { cmd: "echo", args: { mode: { choices: ["safe"] } } }, args: ["unsafe"], field: "mode" },
  { task: { cmd: "echo", service: ":svc", flags: { svc: { alias: "s" } } }, args: [], field: "svc" },
];
test.each([...invalidInputs])(
  "rejects invalid input before selecting a provider: $field",
  async ({ task, args, field }) => {
    // Given a declared input
    const f = fixture(task);
    // When invalid argv is submitted
    const result = await f.run({ args });
    // Then validation prevents all execution
    expect(result).toMatchObject({ _tag: "Left", left: { _tag: "ToolingInputError", field } });
    expect(f.selections).toHaveLength(0);
    expect(f.calls).toHaveLength(0);
  },
);

test("resolves a service from its validated flag alias", async () => {
  // Given a service reference and alias
  const f = fixture({ cmd: "echo", service: ":svc", flags: { svc: { alias: "s", choices: ["worker"] } } });
  // When the alias supplies the service
  const result = await f.run({ args: ["-s", "worker"] });
  // Then the provider receives the resolved service
  expect(Either.isRight(result)).toBe(true);
  expect(f.calls[0]?.service).toBe("worker");
});

test("never selects a provider for all-host tooling", async () => {
  // Given host-only steps
  const f = fixture({ service: ":host", cmds: ["echo first", "echo last"] });
  // When invoked with raw argv
  const result = await f.run({ args: ["a b"] });
  // Then host steps run without provider selection and only the last receives argv
  expect(Either.isRight(result)).toBe(true);
  expect(f.selections).toHaveLength(0);
  expect(f.calls.map((call) => call.command)).toEqual([["echo first"], ["echo last", "a b"]]);
});

test("selects once and executes mixed steps in authored order", async () => {
  // Given alternating destinations
  const f = fixture({
    cmds: [
      { cmd: "first", service: "worker" },
      { cmd: "second", service: ":host" },
      { cmd: "third", service: "worker" },
    ],
  });
  // When invoked
  const result = await f.run();
  // Then no grouping or reordering occurs
  expect(Either.isRight(result)).toBe(true);
  expect(f.selections).toHaveLength(1);
  expect(f.calls.map((call) => call.service)).toEqual(["worker", ":host", "worker"]);
});

test.each([
  { step: { cmd: "echo", user: "step-user" }, expected: { user: "step-user", cwd: "/task" } },
  { step: { cmd: "echo", dir: PortablePath.make("/step") }, expected: { user: "task-user", cwd: "/step" } },
])("inherits task settings independently when a step overrides $step", async ({ step, expected }) => {
  // Given task defaults and one step override
  const f = fixture({ user: "task-user", dir: PortablePath.make("/task"), cmds: [step] });
  // When invoked with a fallback cwd
  await f.run({ cwd: "/caller" });
  // Then only the authored override changes its corresponding setting
  expect(f.calls[0]).toMatchObject(expected);
});

test("lets caller user and env override step values", async () => {
  // Given inherited and step-local values
  const f = fixture({
    user: "task",
    env: { KEEP: "task", WIN: "task" },
    cmds: [{ cmd: "echo", user: "step", env: { WIN: "step" } }],
  });
  // When explicit caller options are supplied
  await f.run({ user: "caller", env: { WIN: "caller" } });
  // Then caller values win
  expect(f.calls[0]).toMatchObject({ user: "caller", env: { KEEP: "task", WIN: "caller" } });
});

test("preserves ToolingExecError for an unknown service", async () => {
  // Given a nonexistent service
  const f = fixture({ cmd: "echo", service: "missing" });
  // When invoked
  const result = await f.run();
  // Then the service resolver keeps its error contract
  expect(result).toMatchObject({ _tag: "Left", left: { _tag: "ToolingExecError" } });
});

test.each(["worker", ":host"])("stops at the first nonzero step on %s", async (service) => {
  // Given a failing first step followed by another destination
  const f = fixture(
    {
      cmds: [
        { cmd: "fail", service },
        { cmd: "never", service: ":host" },
      ],
    },
    17,
  );
  // When invoked
  const result = await f.run();
  // Then execution stops and the failing step's exit code is the task result
  expect(result).toMatchObject({ _tag: "Right", right: { exitCode: 17 } });
  expect(f.calls).toHaveLength(1);
});

test("preserves arguments false rejection", async () => {
  // Given a task that rejects arguments
  const f = fixture({ cmd: "echo", arguments: false });
  // When arguments are provided
  const result = await f.run({ args: ["extra"] });
  // Then the original compile error tag is retained
  expect(result).toMatchObject({ _tag: "Left", left: { _tag: "ToolingCompileError" } });
  expect(f.selections).toHaveLength(0);
});

test("accepts declared flags when arguments is false", async () => {
  // Given declared flags on a task that rejects leftover positionals
  const f = fixture({
    cmd: "echo",
    arguments: false,
    flags: { verbose: { boolean: true } },
    service: ":host",
  });
  // When a declared flag is supplied
  const result = await f.run({ args: ["--verbose"] });
  // Then the flag is parsed instead of treated as a forbidden positional
  expect(result).toMatchObject({ _tag: "Right" });
  expect(f.selections).toHaveLength(0);
});
