import { expect, test } from "bun:test";
import { authoredInvocationSites } from "@lando/landofile/compiled-sites";
import { PortablePath, type ToolingInvocationInput, type ToolingTaskShape } from "@lando/sdk/schema";
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
