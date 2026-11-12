import { expect, test } from "bun:test";
import { authoredInvocationSites } from "@lando/landofile/compiled-sites";
import { PortablePath, type ToolingTaskShape } from "@lando/sdk/schema";
import { $, spawn } from "bun";
import { Cause, Effect, Exit } from "effect";
import { resolveToolingTaskShape } from "../../src/tooling/step-runner.ts";

const resolve = (task: ToolingTaskShape, value: string, vars: Record<string, unknown> = {}) =>
  Effect.runPromise(
    resolveToolingTaskShape(task, { vars }, authoredInvocationSites(task, "test"), {
      name: "t",
      evaluate: () => Effect.succeed(value),
    }),
  ).then((resolved) => resolved.task);

test("dynamic vars are evaluated once in declaration order and replaced by literals", async () => {
  const task = {
    cmd: "echo {{ vars.A }} {{ vars.A }} {{ vars.B }}",
    vars: { A: { sh: "one" }, B: { sh: "two" } },
  };
  const seen: string[] = [];
  const resolved = await Effect.runPromise(
    resolveToolingTaskShape(task, {}, authoredInvocationSites(task, "test"), {
      name: "t",
      evaluate: ({ command }) =>
        Effect.sync(() => {
          seen.push(command);
          return command;
        }),
    }),
  ).then((resolved) => resolved.task);
  expect(seen).toEqual(["one", "two"]);
  expect(resolved.cmd).toBe("echo 'one' 'one' 'two'");
  expect(resolved.vars).toEqual({ A: "one", B: "two" });
});

test.each(["", false, 0])("caller var %j suppresses shell evaluation", async (value) => {
  const task = { cmd: "echo {{ vars.V }}", vars: { V: { sh: "never" } } };
  const resolved = await Effect.runPromise(
    resolveToolingTaskShape(task, { vars: { V: value } }, authoredInvocationSites(task, "test"), {
      name: "t",
      evaluate: () => Effect.die("caller override must suppress execution"),
    }),
  ).then((resolved) => resolved.task);
  expect(resolved.vars?.V).toBe(value);
  expect(resolved.cmd).toBe(value === "" ? "echo " : `echo '${value}'`);
});

test.each([
  { vars: { A: "{{ vars.B }}", B: { sh: "never" } } },
  { service: "{{ vars.B }}", vars: { B: { sh: "never" } } },
  { user: "{{ vars['B'] }}", vars: { B: { sh: "never" } } },
  { dir: PortablePath.make("{{ vars[vars.selector] }}"), vars: { B: { sh: "never" }, selector: "B" } },
  { vars: { A: { sh: "echo {{ vars }}" }, B: { sh: "never" } } },
])("rejects dependent definitions before evaluation: %j", async (fields) => {
  const task = { cmd: "echo", ...fields };
  const result = await Effect.runPromise(
    Effect.result(
      resolveToolingTaskShape(task, {}, authoredInvocationSites(task, "test"), {
        name: "t",
        evaluate: () => Effect.die("reference checking must precede execution"),
      }),
    ),
  );
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ToolingCompileError", tool: "t", message: expect.stringMatching(/^tooling\.t\./) },
  });
});

const commands = [
  "printf '%s' {{ vars.V }}",
  "printf '%s' \"{{ vars.V }}\"",
  "printf '%s' '{{ vars.V }}'",
  "printf '%s' \"$(printf '%s' {{ vars.V }})\"",
  "printf '%s' \"$(printf '%s' '{{ vars.V }}')\"",
  "printf '%s' \"$(printf '%s' \"{{ vars.V }}\")\"",
];
const values = [
  "",
  "plain",
  "a'b\"c\\d",
  "a$(echo PWNED)b; `id` $HOME",
  "line one\nline two",
  "{{ x }}",
  "a'\n$(id)\"\\",
];

for (const cmd of commands) {
  test.each(values)(`binds data in Bun Shell and POSIX sh: ${cmd} (%j)`, async (value) => {
    const task = { cmd, vars: { V: { sh: "compute" } } };
    const resolved = await resolve(task, value);
    if (typeof resolved.cmd !== "string") throw new Error("expected shell command");
    const bun = await $`${{ raw: resolved.cmd }}`.quiet();
    const posix = spawn(["sh", "-c", resolved.cmd], { stdout: "pipe", stderr: "pipe" });
    expect(bun.text()).toBe(value);
    expect(await new Response(posix.stdout).text()).toBe(value);
    expect(await posix.exited).toBe(0);
  });
}

test.each([
  "echo `echo {{ vars.V }}`",
  "cat <<EOF\n{{ vars.V }}\nEOF",
  "cat <<E'O'F\nE'O'F\n{{ vars.V }}\nEOF",
  "cat <<E\\OF\nE\\OF\n{{ vars.V }}\nEOF",
  "echo $((1 + {{ vars.V }}))",
  "echo $${X:-{{ vars.V }}}",
  'echo $${X:-"}"{{ vars.V }}}',
  'echo $(("))" + {{ vars.V }}))',
  "echo $'{{ vars.V }}'",
  'echo "$(case x in x) echo {{ vars.V }};; esac)"',
])("refuses unsafe shell context %s", async (cmd) => {
  const task = { cmd, vars: { V: { sh: "compute" } } };
  const result = await Effect.runPromise(
    Effect.result(
      resolveToolingTaskShape(task, {}, authoredInvocationSites(task, "test"), {
        name: "t",
        evaluate: () => Effect.succeed("value"),
      }),
    ),
  );
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ToolingCompileError" } });
});

test("static vars remain macros and argv and env receive dynamic data unchanged", async () => {
  const task = {
    cmd: ["printf", "{{ vars.V }}", "{{ vars.STATIC }}"],
    env: { VALUE: "{{ vars.V }}" },
    vars: { V: { sh: "compute" }, STATIC: "$(echo macro)" },
  };
  const resolved = await resolve(task, "a'$(echo data)");
  expect(resolved.cmd).toEqual(["printf", "a'$(echo data)", "$(echo macro)"]);
  expect(resolved.env).toEqual({ VALUE: "a'$(echo data)" });
});

test("fails closed when no dynamic evaluator is supplied", async () => {
  const task = { cmd: "echo", vars: { V: { sh: "compute" } } };
  const result = await Effect.runPromise(
    Effect.result(resolveToolingTaskShape(task, {}, authoredInvocationSites(task, "test"))),
  );
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ToolingCompileError" } });
});

test("dynamic evaluator interruption stays interruption", async () => {
  const task = { cmd: "echo", vars: { V: { sh: "compute" } } };
  const exit = await Effect.runPromiseExit(
    resolveToolingTaskShape(task, {}, authoredInvocationSites(task, "test"), {
      name: "t",
      evaluate: () => Effect.interrupt,
    }),
  );
  expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
});
