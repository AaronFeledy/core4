import { expect, test } from "bun:test";
import { authoredInvocationSites } from "@lando/landofile/compiled-sites";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import {
  AbsolutePath,
  AppId,
  type CurrentExecutableAppPlan,
  PortablePath,
  ProviderId,
  type ToolingInvocationInput,
  type ToolingTaskShape,
} from "@lando/sdk/schema";
import { ProcessRunner, RuntimeProviderRegistry, ShellRunner, ToolingEngine } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { DateTime, Effect, Layer } from "effect";
import { prepareToolingInvocation } from "../../src/operations/tooling-prepare.ts";
import * as BunProcessRunner from "../../src/services/process-runner.ts";
import { makeShellRunnerService } from "../../src/services/shell-runner.ts";
import { testEnvironmentResolverLayer } from "../environment-values.ts";
import { ownerOnlyFileAccess } from "../private-file-access.ts";

const plan: CurrentExecutableAppPlan = {
  valueModel: 1,
  id: AppId.make("prepare"),
  name: "prepare",
  slug: "prepare",
  root: AbsolutePath.make(process.cwd()),
  provider: ProviderId.make("test"),
  services: {},
  routes: [],
  fileSync: [],
  stores: [],
  extensions: {},
  metadata: { resolvedAt: DateTime.makeUnsafe("2026-09-12T00:00:00Z"), source: "test", runtime: 4 },
};

const run = (task: ToolingTaskShape, input: ToolingInvocationInput = { _tag: "RawArgv", argv: [] }) => {
  const runner = Effect.runSync(ProcessRunner.pipe(Effect.provide(BunProcessRunner.layer)));
  const layer = Layer.mergeAll(
    BunProcessRunner.layer,
    testEnvironmentResolverLayer,
    Layer.succeed(RedactionService, makeRedactionService()),
    Layer.succeed(
      ShellRunner,
      makeShellRunnerService(
        () => {
          throw new Error("unused REPL");
        },
        ownerOnlyFileAccess,
        runner,
      ),
    ),
    Layer.succeed(ToolingEngine, ToolingEngine.of({ id: "unused", run: () => Effect.die("host only") })),
    Layer.succeed(
      RuntimeProviderRegistry,
      RuntimeProviderRegistry.of({
        appliedPlansFor: () => Effect.succeed([]),
        resolveAppliedPlan: () => Effect.succeed(undefined),
        resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
        list: Effect.succeed([plan.provider]),
        capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
        select: () => Effect.die("host only"),
      }),
    ),
  );
  return Effect.runPromise(
    prepareToolingInvocation({
      plan,
      options: {
        name: "probe",
        lookupKey: "probe",
        task,
        input,
        source: { path: ".lando.yml", task: "probe" },
      },
      sites: authoredInvocationSites(task, "test"),
    }).pipe(Effect.provide(layer), Effect.result),
  );
};

test("registers a sensitive var before a later var reports it in stderr", async () => {
  const result = await run({
    service: ":host",
    cmd: "echo body",
    vars: {
      A: { sh: "printf opaque-sensitive-value", sensitive: true },
      B: { sh: "printf opaque-sensitive-value 1>&2; exit 7" },
    },
  });
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ToolingExecError", variable: "B", exitCode: 7 },
  });
  expect(JSON.stringify(result)).not.toContain("opaque-sensitive-value");
});

test.each([":host", "container"])(
  "explicit host var target resets task placement (%s task)",
  async (service) => {
    const result = await run({
      service,
      user: "task-user",
      dir: PortablePath.make("/does-not-exist"),
      cmd: "echo {{ vars.WHERE }}",
      vars: {
        WHERE: { sh: "pwd", service: ":host" },
      },
    });
    expect(result).toMatchObject({ _tag: "Success" });
    if (result._tag === "Success")
      expect(result.success.invocations[0]?.commands[0]?.[2]).toContain(process.cwd());
  },
);

test("rejects an invalid later var target before any shell command", async () => {
  const result = await run({
    service: ":host",
    cmd: "echo body",
    vars: {
      A: { sh: "exit 8" },
      B: { sh: "echo late", service: ":missing" },
    },
  });
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: {
      _tag: "ToolingCompileError",
      message: expect.stringContaining("tooling.probe.vars.B.service"),
    },
  });
});

test("withholds all diagnostics of a failing sensitive var", async () => {
  const result = await run({
    service: ":host",
    cmd: "echo body",
    vars: {
      API_TOKEN: { sh: "printf unknown-secret 1>&2; exit 7" },
    },
  });
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ToolingExecError", message: expect.stringContaining("withheld") },
  });
  expect(JSON.stringify(result)).not.toContain("unknown-secret");
});

test("cancels an endless producer when stdout crosses 64 KiB", async () => {
  const result = await run({
    service: ":host",
    cmd: "echo body",
    vars: {
      X: { sh: "yes overflow" },
    },
  });
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ToolingExecError", variable: "X", message: expect.stringContaining("64 KiB") },
  });
  if (result._tag === "Failure") expect(result.failure).not.toHaveProperty("exitCode");
}, 3000);

test("binds declared input in var shell text before capture and consumes it once", async () => {
  const value = "safe; echo INJECTED";
  const result = await run(
    {
      service: ":host",
      flags: { name: {} },
      cmd: "echo {{ vars.VALUE }}",
      vars: { VALUE: { sh: "printf '%s' {{ flags.name }}" } },
    },
    { _tag: "RawArgv", argv: [`--name=${value}`] },
  );
  expect(result).toMatchObject({ _tag: "Success" });
  if (result._tag === "Success")
    expect(result.success.invocations[0]?.commands).toEqual([
      ["sh", "-c", "echo 'safe; echo INJECTED' \"$@\"", "lando-tooling"],
    ]);
});

test("refuses raw placement before any dynamic command starts", async () => {
  const result = await run({ service: ":host", cmd: "echo prefix{{ raw }}", vars: { X: { sh: "exit 8" } } });
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ToolingCompileError" } });
});

test.each([{ argv: [] }, { argv: ["--unknown"] }, { argv: ["--target=web"] }])(
  "malformed wrapper fails before input binding or dynamic commands for %j",
  async ({ argv }) => {
    const result = await run(
      {
        service: ":host",
        wrapper: true,
        cmd: "exit 9",
        flags: { target: { required: true } },
        vars: { X: { sh: "exit 8" } },
      },
      { _tag: "RawArgv", argv },
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ToolingCompileError", message: expect.stringContaining("wrapper:") },
    });
  },
);

test("missing invocation values name the input and remediation before dynamic commands", async () => {
  const result = await run({
    service: ":host",
    cmd: "echo {{ flags.name }}",
    flags: { name: {} },
    vars: { X: { sh: "exit 8" } },
  });
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: {
      _tag: "ToolingInputError",
      field: "flags.name",
      remediation: expect.stringContaining("default()"),
    },
  });
});
