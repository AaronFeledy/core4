import { expect, test } from "bun:test";
import { loadAuthoredDocuments } from "@lando/landofile/root-compile";
import {
  AbsolutePath,
  AppId,
  type CurrentExecutableAppPlan,
  type DatabaseConnection,
  GlobalConfig,
  type LoadScopedLandofile,
  PortNumber,
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
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { DateTime, Effect, Layer, Result, Schema, Stream } from "effect";
import { type RunToolingOptions, runTooling } from "../../src/operations/tooling.ts";
import { attachEffectiveTooling } from "../../src/planner/effective-tooling.ts";
import * as BunProcessRunner from "../../src/services/process-runner.ts";
import * as ProviderExecToolingEngine from "../../src/services/tooling-engine.ts";

const fixture = (
  task: ToolingTaskShape,
  failureCode = 0,
  database?: DatabaseConnection,
  output: { readonly stdout?: string; readonly stderr?: string } = {},
) => {
  const calls: {
    readonly service: string;
    readonly command: readonly string[];
    readonly user?: string;
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string>>;
  }[] = [];
  const selections: number[] = [];
  let discovery = compileTestLandofile({ name: "tooling-test", tooling: { custom: task } });
  const metadata = {
    resolvedAt: DateTime.makeUnsafe("2026-05-18T00:00:00Z"),
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
    endpoints: [],
    routes: [],
    dependsOn: [],
    hostAliases: [],
    metadata,
    extensions: {},
  };
  let plan: CurrentExecutableAppPlan = {
    valueModel: 1,
    id: AppId.make("tooling-test"),
    name: "tooling-test",
    slug: "tooling-test",
    root: AbsolutePath.make(process.cwd()),
    provider: service.provider,
    services: {
      [service.name]: service,
      ...(database === undefined
        ? {}
        : {
            [ServiceName.make("database")]: {
              ...service,
              name: ServiceName.make("database"),
              primary: false,
              connection: database,
            },
          }),
    },
    routes: [],
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
      return Stream.make(
        { kind: "stdout" as const, chunk: new TextEncoder().encode(output.stdout ?? "") },
        { kind: "stderr" as const, chunk: new TextEncoder().encode(output.stderr ?? "") },
        { exitCode: failureCode },
      );
    },
  };
  const config = Schema.decodeUnknownSync(GlobalConfig)({});
  const layer = Layer.mergeAll(
    BunProcessRunner.layer,
    testEnvironmentResolverLayer,
    PrivateFileAccessService.layer,
    ProviderExecToolingEngine.layer.pipe(Layer.provide(testEnvironmentResolverLayer)),
    Layer.succeed(
      LandofileService,
      LandofileService.of({
        discover: Effect.suspend(() => discovery),
      }),
    ),
    Layer.succeed(AppPlanner, AppPlanner.of({ plan: () => Effect.succeed(plan) })),
    Layer.succeed(
      ConfigService,
      ConfigService.of({ load: Effect.succeed(config), get: (key) => Effect.succeed(config[key]) }),
    ),
    Layer.succeed(
      RuntimeProviderRegistry,
      RuntimeProviderRegistry.of({
        appliedPlansFor: () => Effect.succeed([]),
        resolveAppliedPlan: () => Effect.succeed(undefined),
        resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
        list: Effect.succeed([service.provider]),
        capabilities: Effect.succeed(provider.capabilities),
        select: () =>
          Effect.sync(() => {
            selections.push(1);
            return provider;
          }),
      }),
    ),
    Layer.succeed(
      ShellRunner,
      ShellRunner.of({
        exec: (source, options) =>
          Effect.sync(() => {
            calls.push({
              service: ":host",
              command: [source, ...(options?.argv ?? [])],
              ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
              ...(options?.env === undefined ? {} : { env: options.env }),
            });
            return { exitCode: failureCode, stdout: output.stdout ?? "", stderr: output.stderr ?? "" };
          }),
        runScript: () => Effect.die("unused script"),
        run: () => Effect.die("unused run"),
        interactive: () => Effect.die("unused interactive"),
      }),
    ),
  );
  return {
    calls,
    selections,
    plan,
    setTooling: (tooling: Readonly<Record<string, ToolingTaskShape>>) => {
      plan = attachEffectiveTooling(plan, tooling);
    },
    setLandofile: (compiled: LoadScopedLandofile) => {
      discovery = Effect.succeed(compiled);
    },
    run: (options: Omit<RunToolingOptions, "name"> = {}) =>
      Effect.runPromise(
        runTooling({ name: "custom", ...options }).pipe(Effect.provide(layer), Effect.result),
      ),
  };
};

test("host dynamic vars run before commands without forwarding env or argv", async () => {
  const f = fixture(
    {
      service: ":host",
      cmd: 'echo "{{ vars.V }}"',
      vars: { V: { sh: "printf computed" } },
      env: { RESULT: "{{ vars.V }}" },
    },
    0,
    undefined,
    { stdout: "computed\r\n" },
  );
  const result = await f.run({ input: { _tag: "RawArgv", argv: ["tail"] } });
  expect(result._tag).toBe("Success");
  expect(f.calls.map((call) => call.command)).toEqual([["printf computed"], ['echo "computed"', "tail"]]);
  expect(f.calls[0]?.env).not.toHaveProperty("RESULT");
  expect(f.calls[1]?.env).toHaveProperty("RESULT", "computed");
  expect(f.selections).toEqual([]);
});

test("container dynamic vars use task placement and share a lazy provider", async () => {
  const f = fixture(
    {
      service: ":target",
      flags: { target: { default: "worker" } },
      user: "www",
      dir: PortablePath.make("/app/src"),
      cmd: "echo {{ vars.A }} {{ vars.B }}",
      vars: { A: { sh: "first" }, B: { sh: "second" } },
      env: { TASK_ENV: "body" },
    },
    0,
    undefined,
    { stdout: "value\n" },
  );
  const result = await f.run({ user: "override" });
  expect(result._tag).toBe("Success");
  expect(f.calls.slice(0, 2)).toMatchObject([
    {
      service: "worker",
      user: "override",
      cwd: "/app/src",
      command: ["sh", "-c", 'first "$@"', "lando-tooling"],
    },
    {
      service: "worker",
      user: "override",
      cwd: "/app/src",
      command: ["sh", "-c", 'second "$@"', "lando-tooling"],
    },
  ]);
  expect(f.calls[0]?.env).not.toHaveProperty("TASK_ENV");
  expect(f.calls[1]?.env).not.toHaveProperty("TASK_ENV");
  expect(f.calls[2]?.command[2]).toContain("echo 'value' 'value'");
  expect(f.selections).toHaveLength(2);
});

test("dynamic var nonzero exit fails before the body", async () => {
  const f = fixture({ service: ":host", cmd: "body-marker", vars: { X: { sh: "exit 3" } } }, 3);
  const result = await f.run();
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ToolingExecError", variable: "X", exitCode: 3 },
  });
  expect(f.calls.map((call) => call.command)).toEqual([["exit 3"]]);
});

test("dynamic var stdout exceeding 64 KiB fails before the body", async () => {
  const f = fixture({ service: ":host", cmd: "body-marker", vars: { X: { sh: "large" } } }, 0, undefined, {
    stdout: "x".repeat(65537),
  });
  const result = await f.run();
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ToolingExecError", variable: "X", message: expect.stringContaining("64 KiB") },
  });
  expect(f.calls).toHaveLength(1);
});

test("dynamic var diagnostics redact plan secrets before retaining a bounded stderr tail", async () => {
  const secret = "opaque-dynamic-failure";
  const f = fixture(
    { service: ":host", cmd: "body-marker", vars: { X: { sh: "fail" } } },
    3,
    {
      family: "postgres",
      port: PortNumber.make(5432),
      creds: { user: "lando", password: secret, database: "appdb" },
    },
    { stderr: `${"x\n".repeat(6000)}${secret} failure-tail` },
  );
  const result = await f.run();
  if (result._tag === "Failure") {
    expect(result.failure.message).not.toContain(secret);
    expect(result.failure.message).toContain("[redacted]");
    expect(result.failure.message.length).toBeLessThan(8 * 1024 + 256);
  }
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ToolingExecError", variable: "X", message: expect.stringContaining("failure-tail") },
  });
});

test("disabled tasks never run dynamic vars", async () => {
  const f = fixture({ disabled: true, service: ":host", cmd: "body-marker", vars: { X: { sh: "never" } } });
  const result = await f.run();
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ToolingDisabledError" } });
  expect(f.calls).toEqual([]);
});

test("input argv cannot carry fails before any dynamic var runs", async () => {
  const f = fixture({
    service: ":host",
    cmd: "body-marker",
    args: { first: { order: 0 }, second: { order: 1 } },
    vars: { X: { sh: "never" } },
  });
  const result = await f.run({ input: { _tag: "NamedMaps", flags: {}, args: { second: "b" } } });
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ToolingInputError" } });
  expect(f.calls).toEqual([]);
});

test("a host dynamic var Bun Shell rejects keeps ToolingCompileError at its var path", async () => {
  const f = fixture({ service: ":host", cmd: "body-marker", vars: { X: { sh: "echo $?" } } });
  const result = await f.run();
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: {
      _tag: "ToolingCompileError",
      message: expect.stringMatching(/^tooling\.custom\.vars\.X\.sh: /),
    },
  });
  expect(f.calls).toEqual([]);
});

test("dynamic var diagnostics never expose a secret pattern clipped from the tail", async () => {
  const f = fixture({ service: ":host", cmd: "body-marker", vars: { X: { sh: "fail" } } }, 3, undefined, {
    stderr: `TOKEN=${"a".repeat(9000)}SUFFIX-SECRET\n`,
  });
  const result = await f.run();
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ToolingExecError", variable: "X" } });
  if (result._tag === "Failure") expect(result.failure.message).not.toContain("SUFFIX-SECRET");
});

test("container dynamic vars honor the app's agent env opt-out", async () => {
  const task: ToolingTaskShape = { cmd: "body-marker", vars: { X: { sh: "compute" } } };
  const f = fixture(task, 0, undefined, { stdout: "value" });
  f.setLandofile(
    await Effect.runPromise(
      compileTestLandofile({ name: "tooling-test", agentEnv: false, tooling: { custom: task } }),
    ),
  );
  const previous = process.env.CLAUDECODE;
  process.env.CLAUDECODE = "1";
  try {
    const result = await f.run();
    expect(result._tag).toBe("Success");
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "CLAUDECODE");
    else process.env.CLAUDECODE = previous;
  }
  expect(f.calls[0]?.command).toEqual(["sh", "-c", 'compute "$@"', "lando-tooling"]);
  expect(f.calls[0]?.env ?? {}).not.toHaveProperty("CLAUDECODE");
});

test("rejects a freshly disabled task even when the plan carries an enabled task", async () => {
  // Given an enabled cached plan and a freshly loaded disabled declaration
  const f = fixture({ cmd: "echo ok", disabled: true });
  f.setTooling({ custom: { cmd: "echo stale" } });
  // When invoked
  const result = await f.run();
  // Then the fresh declaration is authoritative
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ToolingDisabledError", tool: "custom", source: { task: "custom" } },
  });
  expect(f.selections).toHaveLength(0);
});

test.each([false, { disabled: true }])(
  "attributes a fresh disabled value %j rather than the task root",
  async (disabled) => {
    const root = process.cwd();
    const file = `${root}/.lando.local.yml`;
    const compiled = await Effect.runPromise(
      loadAuthoredDocuments(
        [
          {
            file: `${root}/.lando.yml`,
            value: { name: "tooling-test", tooling: { custom: { cmd: "echo base" } } },
          },
          { file, value: { tooling: { custom: disabled } } },
          {
            file: `${root}/.lando.user.yml`,
            value: {
              tooling:
                disabled === false
                  ? { other: { cmd: "echo user" } }
                  : { custom: { description: "higher task root" } },
            },
          },
        ],
        { appRoot: root, file: `${root}/.lando.yml` },
      ),
    );
    const f = fixture({ disabled: true });
    f.setLandofile(compiled);
    const result = await f.run();
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "ToolingDisabledError",
        source: { path: file, task: "custom" },
        remediation: expect.stringContaining(file),
      },
    });
  },
);

test("resolves app and proxy expressions in a freshly authored task", async () => {
  // Given a fresh declaration carrying deferred-scope expressions
  const f = fixture({
    cmd: "echo {{ app.name }} {{ proxy.defaultDomain }} db=mysql://lando@database/{{ app.name }}",
    service: "worker",
  });
  // When invoked
  const result = await f.run();
  // Then the container sees the slug and default domain, never the literal template
  expect(Result.isSuccess(result)).toBe(true);
  expect(f.calls[0]?.command.join(" ")).toContain(
    "echo tooling-test lndo.site db=mysql://lando@database/tooling-test",
  );
  expect(f.calls[0]?.command.join(" ")).not.toContain("{{");
});

test("resolves services.<name>.creds.* in a freshly authored task from the plan's service scope", async () => {
  // Given a fresh declaration reading another service's credentials, and a plan resolved with them
  const f = fixture(
    {
      cmd: "psql -U {{ services.database.creds.user }} -d {{ services.database.creds.database }}@{{ app.name }}",
      service: "worker",
    },
    0,
    {
      family: "postgres",
      port: PortNumber.make(5432),
      creds: { user: "lando", password: "pw", database: "appdb" },
    },
  );
  // When invoked
  const result = await f.run();
  // Then the container sees the credentials the planner published, never the literal template
  expect(Result.isSuccess(result)).toBe(true);
  expect(f.calls[0]?.command.join(" ")).toContain("psql -U lando -d appdb@tooling-test");
  expect(f.calls[0]?.command.join(" ")).not.toContain("{{");
});

test("fails with ConfigExpressionError when a fresh task reads a service the plan does not know", async () => {
  // Given a fresh declaration reading credentials no plan service published
  const f = fixture({ cmd: "echo {{ services.database.creds.user }}", service: "worker" });
  // When invoked
  const result = await f.run();
  // Then the tagged planner error names the tooling path
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ConfigExpressionError", path: ["tooling", "custom", "cmd"] },
  });
  expect(f.calls).toHaveLength(0);
});

test("fails with ConfigExpressionError when a fresh task references an unknown app field", async () => {
  // Given a fresh declaration with an unresolvable deferred-scope expression
  const f = fixture({ cmd: "echo {{ app.nope }}", service: "worker" });
  // When invoked
  const result = await f.run();
  // Then the tagged planner error names the tooling path
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ConfigExpressionError", path: ["tooling", "custom", "cmd"] },
  });
  expect(f.calls).toHaveLength(0);
});

test.each(["echo", ["echo", "literal value"]])("forwards undeclared argv unchanged for %j", async (cmd) => {
  // Given no declared inputs
  const f = fixture({ cmd });
  const args = ["--bogus", "a b", "", "--", "$literal"];
  // When invoked
  const result = await f.run({ input: { _tag: "RawArgv", argv: args } });
  // Then raw tokens reach the provider
  expect(Result.isSuccess(result)).toBe(true);
  expect(f.calls[0]?.command.slice(-args.length)).toEqual(args);
});

const invalidInputs: readonly {
  readonly task: ToolingTaskShape;
  readonly args: readonly string[];
  readonly field: string | undefined;
}[] = [
  { task: { cmd: "echo", flags: { verbose: { boolean: true } } }, args: ["--bogus"], field: undefined },
  { task: { cmd: "echo", args: { mode: { choices: ["safe"] } } }, args: ["unsafe"], field: "mode" },
  { task: { cmd: "echo", service: ":svc", flags: { svc: { alias: "s" } } }, args: [], field: "svc" },
  ...[":host", ":other", ":"].map((value) => ({
    task: { cmd: "echo", service: ":svc", flags: { svc: {} } },
    args: [`--svc=${value}`],
    field: "svc",
  })),
  {
    task: { cmd: "echo", args: { first: { order: 0 }, second: { order: 1, default: "b" } } },
    args: [],
    field: "first",
  },
];
test.each([...invalidInputs])(
  "rejects invalid input before selecting a provider: $field",
  async ({ task, args, field }) => {
    // Given a declared input
    const f = fixture(task);
    // When invalid argv is submitted
    const result = await f.run({ input: { _tag: "RawArgv", argv: args } });
    // Then validation prevents all execution
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ToolingInputError", ...(field === undefined ? {} : { field }) },
    });
    expect(f.selections).toHaveLength(0);
    expect(f.calls).toHaveLength(0);
  },
);

test("resolves a service from its validated flag alias", async () => {
  // Given a service reference and alias
  const f = fixture({ cmd: "echo", service: ":svc", flags: { svc: { alias: "s", choices: ["worker"] } } });
  // When the alias supplies the service
  const result = await f.run({ input: { _tag: "RawArgv", argv: ["-s", "worker"] } });
  // Then the provider receives the resolved service
  expect(Result.isSuccess(result)).toBe(true);
  expect(f.calls[0]?.service).toBe("worker");
});

test("never selects a provider for all-host tooling", async () => {
  // Given host-only steps
  const f = fixture({ service: ":host", cmds: ["echo first", "echo last"] });
  // When invoked with raw argv
  const result = await f.run({ input: { _tag: "RawArgv", argv: ["a b"] } });
  // Then host steps run without provider selection and only the last receives argv
  expect(Result.isSuccess(result)).toBe(true);
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
  expect(Result.isSuccess(result)).toBe(true);
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
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ToolingExecError" } });
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
  expect(result).toMatchObject({ _tag: "Success", success: { exitCode: 17 } });
  expect(f.calls).toHaveLength(1);
});

test("preserves arguments false rejection", async () => {
  // Given a task that rejects arguments
  const f = fixture({ cmd: "echo", arguments: false });
  // When arguments are provided
  const result = await f.run({ input: { _tag: "RawArgv", argv: ["extra"] } });
  // Then the original compile error tag is retained
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ToolingInputError" } });
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
  const result = await f.run({ input: { _tag: "RawArgv", argv: ["--verbose"] } });
  // Then the flag is parsed instead of treated as a forbidden positional
  expect(result).toMatchObject({ _tag: "Success" });
  expect(f.selections).toHaveLength(0);
});
import { compileTestLandofile } from "../compiled-landofile.ts";
import { testEnvironmentResolverLayer } from "../environment-values.ts";
