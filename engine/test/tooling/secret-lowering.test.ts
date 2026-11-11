import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InvocationSite,
  authoredInvocationSites,
  bindToolingShellSite,
  compileInvocationSites,
} from "@lando/landofile/compiled-sites";
import { loadAuthoredDocuments } from "@lando/landofile/root-compile";
import type { ExpressionContext, ExpressionSegment } from "@lando/sdk/expressions";
import type { SecretRef, ToolingTaskShape } from "@lando/sdk/schema";
import { $, spawn } from "bun";
import { Effect } from "effect";
import { sitesUnder } from "../../src/planner/invocation-authority.ts";
import { resolveToolingTaskShape } from "../../src/tooling/step-runner.ts";

const POSIX = process.platform !== "win32";
const load = (document: unknown) =>
  Effect.runPromise(
    loadAuthoredDocuments([{ file: "/tmp/lando-secret/.lando.yml", value: document }], {
      appRoot: "/tmp/lando-secret",
      file: "/tmp/lando-secret/.lando.yml",
    }),
  );
const BASE_ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp" };

const resolveCmd = (cmd: string, context: ExpressionContext = {}, vars?: ToolingTaskShape["vars"]) => {
  const task = { cmd, ...(vars === undefined ? {} : { vars }) };
  return Effect.runPromise(
    resolveToolingTaskShape(task, context, authoredInvocationSites(task, "secret.yml")),
  );
};

const OTHER = "other value";
const boundEnv = (bindings: Readonly<Record<string, SecretRef>>, value: string) =>
  Object.fromEntries(
    Object.entries(bindings).map(([name, ref]) => [name, ref.reference === "B" ? OTHER : value]),
  );

const commandText = (task: ToolingTaskShape): string => {
  if (typeof task.cmd !== "string") throw new Error("expected shell text");
  return task.cmd;
};

const runBun = async (command: string, env: Record<string, string>) =>
  (await $`${{ raw: command }}`.env(env).quiet()).text();

const runSh = async (command: string, env: Record<string, string>) => {
  const child = spawn(["/bin/sh", "-c", command], { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`sh -c exited ${code}: ${stderr}`);
  return stdout;
};

const hostileValues = [
  "with space",
  "tab\there",
  "line\nbreak",
  "*",
  "?",
  "[a]",
  "$HOME",
  "$(touch x)",
  "`id`",
  "'",
  '"',
  "\\",
  "!",
  "",
  "-leading",
];

const templates: ReadonlyArray<{
  readonly name: string;
  readonly command: (file: string) => string;
  readonly expected: (value: string) => string;
  readonly context?: ExpressionContext;
  readonly renderedAsFile?: boolean;
}> = [
  {
    name: "unquoted",
    command: () => "printf '[%s]' ${secret:A} end",
    expected: (value) => `[${value}][end]`,
  },
  {
    name: "single-quoted",
    command: () => "printf '[%s]' '${secret:A}' end",
    expected: (value) => `[${value}][end]`,
  },
  {
    name: "double-quoted",
    command: () => 'printf "[%s]" "${secret:A}" end',
    expected: (value) => `[${value}][end]`,
  },
  {
    name: "glued unquoted",
    command: () => "printf '[%s]\\n' pre${secret:A}post",
    expected: (value) => `[pre${value}post]\n`,
  },
  {
    name: "glued single-quoted",
    command: () => "printf '[%s]\\n' 'pre${secret:A}post'",
    expected: (value) => `[pre${value}post]\n`,
  },
  {
    name: "glued double-quoted",
    command: () => 'printf "[%s]\\n" "pre${secret:A}post"',
    expected: (value) => `[pre${value}post]\n`,
  },
  {
    name: "inside command substitution",
    command: () => 'printf "[%s]\\n" "$(printf %s ${secret:A})"',
    expected: (value) => `[${value}]\n`,
  },
  {
    name: "assignment prefix",
    command: () => 'KEY=${secret:A} sh -c \'printf "[%s]\\n" "$KEY"\'',
    expected: (value) => `[${value}]\n`,
  },
  {
    name: "output redirection",
    command: (file) => `printf '%s' \${secret:A} > ${file}`,
    expected: (value) => value,
    renderedAsFile: true,
  },
  {
    name: "two references",
    command: () => "printf '[%s]' ${secret:A} ${secret:B} end",
    expected: (value) => `[${value}][${OTHER}][end]`,
  },
  {
    name: "same reference twice",
    command: () => "printf '[%s][%s]\\n' ${secret:A} ${secret:A}",
    expected: (value) => `[${value}][${value}]\n`,
  },
  {
    name: "after a quoted interpolation",
    command: () => "printf '[%s]\\n' {{ vars.PREFIX }}${secret:A}",
    expected: (value) => `[x " ' \\ $ \`${value}]\n`,
    context: { vars: { PREFIX: "x \" ' \\ $ `" } },
  },
];

for (const template of templates) {
  test.each(hostileValues)(`${template.name} binds exact bytes under Bun Shell: %j`, async (value) => {
    // Given
    const file = join(tmpdir(), `lando-secret-${randomUUID()}`);
    const resolved = await resolveCmd(template.command(file), template.context);
    if (typeof resolved.task.cmd !== "string") throw new Error("expected shell text");
    const bindings = resolved.bindings.commands.get("cmd") ?? {};
    const env = { ...BASE_ENV, ...boundEnv(bindings, value) };
    try {
      // When
      const output = await runBun(resolved.task.cmd, env);
      // Then
      if (template.renderedAsFile) expect(await Bun.file(file).text()).toBe(template.expected(value));
      else expect(output).toBe(template.expected(value));
    } finally {
      await rm(file, { force: true });
    }
  });

  test.skipIf(!POSIX).each(hostileValues)(
    `${template.name} binds exact bytes under sh -c: %j`,
    async (value) => {
      // Given
      const file = join(tmpdir(), `lando-secret-${randomUUID()}`);
      const resolved = await resolveCmd(template.command(file), template.context);
      if (typeof resolved.task.cmd !== "string") throw new Error("expected shell text");
      const bindings = resolved.bindings.commands.get("cmd") ?? {};
      const env = { ...BASE_ENV, ...boundEnv(bindings, value) };
      try {
        // When
        const output = await runSh(resolved.task.cmd, env);
        // Then
        if (template.renderedAsFile) expect(await Bun.file(file).text()).toBe(template.expected(value));
        else expect(output).toBe(template.expected(value));
      } finally {
        await rm(file, { force: true });
      }
    },
  );
}

test("an escaped reference stays literal text and creates no binding", async () => {
  // Given
  const resolved = await resolveCmd("printf '%s' '$${secret:A}'");
  // When
  const bindings = resolved.bindings.commands.get("cmd") ?? {};
  const output = await runBun(commandText(resolved.task), { ...BASE_ENV, ...boundEnv(bindings, "unused") });
  // Then
  expect(Object.keys(bindings)).toHaveLength(0);
  expect(output).toBe("${secret:A}");
});

test("the same reference in one command produces one binding", async () => {
  // Given
  const resolved = await resolveCmd("printf '%s' ${secret:A} ${secret:A}");
  // Then
  const bindings = resolved.bindings.commands.get("cmd") ?? {};
  expect(Object.values(bindings)).toEqual([{ _tag: "SecretRef", reference: "A" }]);
});

const generatedName = async (command: string) => {
  const bindings = (await resolveCmd(command)).bindings.commands.get("cmd") ?? {};
  const name = Object.keys(bindings)[0];
  if (name === undefined) throw new Error("expected a generated binding");
  return name;
};

test("a generated binding that collides with authored command text is refused", async () => {
  // Given
  const name = await generatedName("printf '%s' ${secret:A}");
  const command = `printf '%s' $${name} \${secret:A}`;
  const task = { cmd: command };
  // When
  const result = await Effect.runPromise(
    Effect.result(resolveToolingTaskShape(task, {}, authoredInvocationSites(task, "secret.yml"))),
  );
  // Then
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ToolingCompileError" } });
});

test("a generated binding that collides with the authored environment is refused", async () => {
  // Given
  const name = await generatedName("printf '%s' ${secret:A}");
  const task = { cmd: "printf '%s' ${secret:A}", env: { [name]: "authored" } };
  // When
  const result = await Effect.runPromise(
    Effect.result(resolveToolingTaskShape(task, {}, authoredInvocationSites(task, "secret.yml"))),
  );
  // Then
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ToolingCompileError" } });
});

const refused: ReadonlyArray<{ readonly name: string; readonly command: string; readonly context: string }> =
  [
    { name: "comment", command: "printf '%s' value # ${secret:A}", context: "a shell comment" },
    { name: "here-document", command: "cat <<EOF\n${secret:A}\nEOF", context: "a here-document" },
    { name: "backtick", command: "printf '%s' `printf %s ${secret:A}`", context: "a backtick" },
    { name: "arithmetic", command: "printf '%s' $((1 + ${secret:A}))", context: "arithmetic" },
    { name: "dollar-quote", command: "printf '%s' $'${secret:A}'", context: "quoted string" },
    { name: "escaped", command: "printf '%s' \\${secret:A}", context: "an escaped reference" },
    {
      name: "case inside a command substitution",
      command: 'printf "%s" "$(case x in x) printf %s ${secret:A};; esac)"',
      context: "a `case` statement",
    },
  ];

for (const refusal of refused) {
  test(`refuses ${refusal.name} at invocation with site advice after an interpolation`, async () => {
    // Given an interpolation precedes the secret so load cannot check it statically.
    const document = {
      name: "probe",
      tooling: { deploy: { cmd: `{{ vars.PREFIX }} ${refusal.command}` } },
    };
    const compiled = await load(document);
    const sites = await Effect.runPromise(
      compileInvocationSites(compiled.pendingSites, {}, compiled.document),
    );
    const task = compiled.document.tooling?.deploy;
    if (task === undefined) throw new Error("expected tooling.deploy");
    // When
    const result = await Effect.runPromise(
      Effect.result(
        resolveToolingTaskShape(
          task,
          { vars: { PREFIX: "value" } },
          sitesUnder(sites, ["tooling", "deploy"]),
        ),
      ),
    );
    // Then
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ToolingCompileError", message: expect.stringContaining(refusal.context) },
    });
    if (result._tag === "Failure") expect(result.failure.remediation).toContain("tooling.deploy.env.A");
  });
}

test("refuses a parameter-expansion position in the assembled shell context", () => {
  // Given a hand-built template whose literal opens a parameter expansion.
  const segments: ExpressionSegment[] = [
    { kind: "LiteralSegment", text: "printf '%s' ${X:-" },
    { kind: "SecretRefSegment", name: "A" },
  ];
  const site = InvocationSite.make({
    id: "parameter",
    path: ["cmd"],
    source: { file: "secret.yml", layer: "base", path: ["cmd"] },
    template: { whole: true, segments },
    expression: "printf '%s' ${X:-${secret:A}",
    captures: {},
  });
  // When / Then
  expect(() => bindToolingShellSite(site, {}, new Set())).toThrow(/parameter expansion/);
});

test("only the step that uses a reference receives its binding", async () => {
  // Given
  const task = { cmds: ["printf '%s' ${secret:A}", "echo plain"] };
  // When
  const resolved = await Effect.runPromise(
    resolveToolingTaskShape(task, {}, authoredInvocationSites(task, "secret.yml")),
  );
  // Then
  expect([...resolved.bindings.commands.keys()]).toEqual(["cmds.0"]);
});

test("a cmd receives its typed secret binding", async () => {
  // Given
  const cmd = await resolveCmd("printf '%s' ${secret:A}");
  const env = cmd.bindings.commands.get("cmd") ?? {};
  // Then
  expect(Object.keys(env)).toHaveLength(1);
  expect(Object.values(env)[0]).toMatchObject({ _tag: "SecretRef", reference: "A" });
});
