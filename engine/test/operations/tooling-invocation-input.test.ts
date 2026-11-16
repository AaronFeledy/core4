import { expect, test } from "bun:test";
import { authoredInvocationSites } from "@lando/landofile/compiled-sites";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import {
  PortablePath,
  ToolingInputRevision,
  type ToolingInvocationInput,
  type ToolingTaskShape,
} from "@lando/sdk/schema";
import { Effect } from "effect";
import { admitToolingTask } from "../../src/operations/tooling-input-admission.ts";

const admit = (task: ToolingTaskShape, input: ToolingInvocationInput) =>
  Effect.runPromise(
    Effect.result(
      admitToolingTask({
        name: "inspect",
        task,
        input,
        source: { path: "/app/.lando.yml", task: "inspect" },
        sites: authoredInvocationSites(task, "/app/.lando.yml"),
      }),
    ),
  );

test.each([
  { _tag: "RawArgv", argv: ["--note=private-note", "--password=private-password"] },
  { _tag: "NamedMaps", flags: { note: { nested: "private-note" }, password: "private-password" }, args: {} },
] satisfies readonly ToolingInvocationInput[])(
  "disabled invalid inputs refuse before normalization and protect supplied values: $_tag",
  async (input) => {
    const redaction = makeRedactionService();
    const result = await Effect.runPromise(
      Effect.result(
        admitToolingTask({
          name: "retired",
          source: { path: "/app/.lando.yml", task: "retired" },
          task: {
            disabled: true,
            wrapper: true,
            cmd: "echo hi",
            flags: { note: { alias: "q", sensitive: true }, password: { alias: "q" } },
          },
          input,
        }),
      ).pipe(Effect.provideService(RedactionService, redaction)),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ToolingDisabledError", tool: "retired" },
    });
    expect(JSON.stringify(result)).not.toContain("private-");
    const redactor = await Effect.runPromise(redaction.forProfile("secrets", { sourceEnv: {} }));
    expect(redactor.redactString("private-note private-password")).toBe("[redacted] [redacted]");
  },
);

test.each(
  (
    [
      { _tag: "RawArgv", argv: [] },
      { _tag: "RawArgv", argv: ["--unknown=private-unknown"] },
      { _tag: "RawArgv", argv: ["--target=private-target"] },
      { _tag: "NamedMaps", flags: {}, args: {} },
      { _tag: "NamedMaps", flags: { unknown: { nested: "private-unknown" } }, args: {} },
      { _tag: "NamedMaps", flags: { target: "private-target" }, args: {} },
    ] satisfies readonly ToolingInvocationInput[]
  ).flatMap((input) => [
    { input, revision: {} },
    { input, revision: { expectedInputRevision: ToolingInputRevision.make("stale") } },
  ]),
)(
  "malformed tasks precede binding and revision checks and protect all values: %j",
  async ({ input, revision }) => {
    const redaction = makeRedactionService();
    const result = await Effect.runPromise(
      admitToolingTask({
        name: "inspect",
        task: { service: ":host", wrapper: true, cmd: "echo hi", flags: { target: { required: true } } },
        source: { path: "/app/.lando.yml", task: "inspect" },
        input,
        ...revision,
      }).pipe(Effect.result, Effect.provideService(RedactionService, redaction)),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ToolingCompileError", message: expect.stringContaining("wrapper:") },
    });
    const redactor = await Effect.runPromise(redaction.forProfile("secrets", { sourceEnv: {} }));
    switch (input._tag) {
      case "RawArgv":
        for (const token of input.argv) {
          expect(redactor.redactString(token)).toBe("[redacted]");
          expect(redactor.redactString(token.slice(token.indexOf("=") + 1))).toBe("[redacted]");
        }
        break;
      case "NamedMaps":
        if ("unknown" in input.flags) expect(redactor.redactString("private-unknown")).toBe("[redacted]");
        if ("target" in input.flags) expect(redactor.redactString("private-target")).toBe("[redacted]");
        break;
      default:
        input satisfies never;
    }
  },
);

test("consuming one flag still forwards an unconsumed verbose flag", async () => {
  const result = await admit(
    { cmd: "echo {{ flags.name }}", flags: { name: {}, verbose: { boolean: true } } },
    { _tag: "RawArgv", argv: ["--name=team", "--verbose"] },
  );
  expect(result).toMatchObject({ _tag: "Success", success: { argv: ["--verbose"] } });
});

test("service selection consumes only its own flag", async () => {
  const result = await admit(
    { service: ":target", cmd: "echo", flags: { target: {}, verbose: { boolean: true } } },
    { _tag: "RawArgv", argv: ["--target=worker", "--verbose"] },
  );
  expect(result).toMatchObject({ _tag: "Success", success: { argv: ["--verbose"] } });
});

test("interpolation fills a sparse named positional hole before residual lowering", async () => {
  const result = await admit(
    {
      cmd: "echo {{ default(args.first, 'fallback') }}",
      args: { first: { order: 0 }, second: { order: 1 } },
    },
    { _tag: "NamedMaps", flags: {}, args: { second: "later" } },
  );
  expect(result).toMatchObject({ _tag: "Success", success: { argv: ["later"] } });
});

test.each(["{{ flags }}", "{{ flags[vars.selector] }}"])(
  "unattributable input reads consume their whole group: %s",
  async (reference) => {
    const result = await admit(
      {
        cmd: `echo ${reference}`,
        flags: { name: {}, verbose: { boolean: true } },
        vars: { selector: "name" },
      },
      { _tag: "RawArgv", argv: ["--name=team", "--verbose"] },
    );
    expect(result).toMatchObject({ _tag: "Success", success: { argv: [] } });
  },
);

test("var definitions and step fields consume the inputs they read", async () => {
  const result = await admit(
    {
      cmds: [{ cmd: "echo {{ vars.LABEL }}", env: { OPT: "{{ flags.verbose }}" } }],
      flags: { name: {}, verbose: { boolean: true } },
      vars: { LABEL: "{{ flags.name }}" },
    },
    { _tag: "RawArgv", argv: ["--name=team", "--verbose"] },
  );
  expect(result).toMatchObject({ _tag: "Success", success: { argv: [] } });
});

test("a task without bindings retains declared forwarding", async () => {
  const result = await admit(
    { cmd: "echo", flags: { name: {}, verbose: { boolean: true } } },
    { _tag: "RawArgv", argv: ["--name=team", "--verbose"] },
  );
  expect(result).toMatchObject({ _tag: "Success", success: { argv: ["--name=team", "--verbose"] } });
});

test("successful admission registers sensitive inputs without redacting ordinary values", async () => {
  const redaction = makeRedactionService();
  const result = await Effect.runPromise(
    admitToolingTask({
      name: "inspect",
      task: { cmd: "echo", flags: { label: {}, credential: { sensitive: true } } },
      input: { _tag: "RawArgv", argv: ["--label=public-label", "--credential=private-value"] },
      source: { path: "/app/tasks.yml", task: "inspect" },
    }).pipe(Effect.result, Effect.provideService(RedactionService, redaction)),
  );
  expect(result._tag).toBe("Success");
  const redactor = await Effect.runPromise(redaction.forProfile("secrets", { sourceEnv: {} }));
  expect(redactor.redactString("public-label private-value")).toBe("public-label [redacted]");
});

test("unknown input references fail at their authored path with a closest name", async () => {
  const result = await admit(
    { cmd: "echo {{ flags.naem }}", flags: { name: {} }, vars: { X: { sh: "exit 8" } } },
    { _tag: "RawArgv", argv: [] },
  );
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: {
      _tag: "ToolingCompileError",
      message: expect.stringContaining("tooling.inspect.cmd"),
      remediation: expect.stringContaining('Did you mean "name"?'),
    },
  });
});

test.each([
  {
    cmd: "echo {{ flags.naem }}",
    flags: { name: { required: true } },
    reason: "unknown-input-reference",
    path: ["cmd"],
  },
  {
    cmd: "echo {{ raw }}",
    flags: { name: { required: true } },
    reason: "raw-with-declared-inputs",
    path: ["cmd"],
  },
  {
    cmd: "echo",
    dir: PortablePath.make("{{ vars.VALUE }}"),
    vars: { VALUE: { sh: "exit 8" } },
    flags: { name: { required: true } },
    reason: "dynamic-var-reference",
    path: ["dir"],
  },
])("static $reason precedes stale revision and invalid input", async ({ reason, path, ...task }) => {
  const result = await Effect.runPromise(
    admitToolingTask({
      name: "inspect",
      task,
      input: { _tag: "RawArgv", argv: ["--unknown=credential"] },
      expectedInputRevision: ToolingInputRevision.make("stale"),
      source: { path: "/app/tasks.yml", task: "inspect" },
      sites: authoredInvocationSites(task, "/app/tasks.yml"),
    }).pipe(Effect.result),
  );
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: {
      _tag: "ToolingCompileError",
      omittedIssueCount: 0,
      issues: [{ reason, path: ["tooling", "inspect", ...path], source: { file: "/app/tasks.yml" } }],
    },
  });
});

test("raw is refused when named input is declared", async () => {
  const result = await admit({ cmd: "echo {{ raw }}", flags: { name: {} } }, { _tag: "RawArgv", argv: [] });
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ToolingCompileError", message: expect.stringContaining("raw is unavailable") },
  });
});

test.each([
  { env: { VALUE: "{{ raw }}" } },
  { dir: PortablePath.make("{{ raw }}") },
  { vars: { VALUE: "{{ raw }}" } },
])("raw outside shell and argv fails static admission: %j", async (fields) => {
  const result = await admit({ cmd: "echo", ...fields }, { _tag: "RawArgv", argv: ["input"] });
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ToolingCompileError", message: expect.stringContaining("raw must occupy") },
  });
});
