import { expect, test } from "bun:test";
import { authoredInvocationSites } from "@lando/landofile/compiled-sites";
import type { ExpressionContext } from "@lando/sdk/expressions";
import type { ToolingTaskShape } from "@lando/sdk/schema";
import { $, spawn } from "bun";
import { Effect } from "effect";
import { resolveLeaf, resolveToolingTaskShape } from "../../src/tooling/step-runner.ts";

const program = `${JSON.stringify(process.execPath)} -e 'console.log(JSON.stringify(process.argv.slice(1)))' --`;
const resolve = (cmd: string, context: ExpressionContext, vars: ToolingTaskShape["vars"] = {}) => {
  const task = { cmd, vars };
  return Effect.runPromise(
    resolveToolingTaskShape(task, context, authoredInvocationSites(task, "binding.yml")),
  );
};
const argv = async (command: string) => {
  const bun = await $`${{ raw: command }}`.quiet();
  const posix = spawn(["sh", "-c", command], { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(posix.stdout).text();
  expect(await posix.exited).toBe(0);
  return [JSON.parse(bun.text()), JSON.parse(output)];
};

test.each(["{{ flags.value }}", '"{{ flags.value }}"', "'{{ flags.value }}'"])(
  "binds input as exactly one argv in %s",
  async (site) => {
    const value = "safe; echo INJECTED $(id) `id` a'b\"c\\d\n# & | Unicode Ω";
    const resolved = await resolve(`${program} ${site}`, { flags: { value } });
    expect(typeof resolved.cmd).toBe("string");
    if (typeof resolved.cmd === "string") expect(await argv(resolved.cmd)).toEqual([[value], [value]]);
  },
);

test("caller overrides and transitive literal vars retain data provenance", async () => {
  const value = "safe; echo INJECTED";
  const resolved = await resolve(
    `${program} {{ vars.C }}`,
    { vars: { A: value } },
    {
      A: "authored",
      B: "{{ default(vars.A, 'fallback') }}",
      C: "{{ vars.B }}",
    },
  );
  if (typeof resolved.cmd !== "string") throw new Error("expected command text");
  expect(await argv(resolved.cmd)).toEqual([[value], [value]]);
});

test("refuses an authored dollar macro before data inside double quotes", async () => {
  const task = { cmd: `${program} "{{ vars.PREFIX }}{{ flags.value }}"`, vars: { PREFIX: "pre$" } };
  const result = await Effect.runPromise(
    Effect.result(
      resolveToolingTaskShape(
        task,
        { flags: { value: "(echo INJECTED)" } },
        authoredInvocationSites(task, "binding.yml"),
      ),
    ),
  );
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ToolingCompileError" } });
});

test.each([
  { site: "'{{ vars.PREFIX }}{{ flags.value }}'", prefix: "pre$" },
  { site: '"{{ vars.PREFIX }}{{ flags.value }}"', prefix: "pre\\$" },
])(
  "preserves a literal dollar before bound data when shell quoting makes it inert: $site",
  async ({ site, prefix }) => {
    const resolved = await resolve(
      `${program} ${site}`,
      { flags: { value: "(echo INJECTED)" } },
      { PREFIX: prefix },
    );
    if (typeof resolved.cmd !== "string") throw new Error("expected command text");
    expect(await argv(resolved.cmd)).toEqual([["pre$(echo INJECTED)"], ["pre$(echo INJECTED)"]]);
  },
);

test.each([
  { site: "{{ flags.value }}", expected: [] },
  { site: '"{{ flags.value }}"', expected: [""] },
  { site: "pre{{ flags.value }}post", expected: ["prepost"] },
])("empty input preserves word rules: $site", async ({ site, expected }) => {
  const resolved = await resolve(`${program} ${site}`, { flags: { value: "" } });
  if (typeof resolved.cmd !== "string") throw new Error("expected command text");
  expect(await argv(resolved.cmd)).toEqual([expected, expected]);
});

test.each([
  "$'{{ flags.value }}'",
  '$"{{ flags.value }}"',
  "echo {{ vars.DOLLAR }}{{ flags.value }}",
  'echo "{{ raw }}"',
  "{{ raw }}",
  "echo pre{{ raw }}",
  "echo > {{ raw }}",
])("refuses unsafe placement %s", async (cmd) => {
  const task = { cmd, vars: { DOLLAR: "$" } };
  const result = await Effect.runPromise(
    Effect.result(
      resolveToolingTaskShape(
        task,
        { flags: { value: "x" }, raw: ["x"] },
        authoredInvocationSites(task, "binding.yml"),
      ),
    ),
  );
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ToolingCompileError" } });
});

test("raw tail preserves element count including empty values", async () => {
  const raw = ["", "a b", "safe; echo INJECTED", "'\"$()`\\\n"];
  const resolved = await resolve(`${program} {{ raw }}`, { raw });
  if (typeof resolved.cmd !== "string") throw new Error("expected command text");
  expect(await argv(resolved.cmd)).toEqual([raw, raw]);
});

test("template comments do not change raw word boundaries", async () => {
  const raw = ["a b", ""];
  const resolved = await resolve(`${program} {{ raw }}{{# hidden #}}`, { raw });
  if (typeof resolved.cmd !== "string") throw new Error("expected command text");
  expect(await argv(resolved.cmd)).toEqual([raw, raw]);
});

test("right trimming cannot attach authored suffix text to raw arguments", async () => {
  const task = { cmd: "echo {{ raw -}} tail" };
  const result = await Effect.runPromise(
    Effect.result(
      resolveToolingTaskShape(task, { raw: ["value"] }, authoredInvocationSites(task, "binding.yml")),
    ),
  );
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ToolingCompileError" } });
});

test.each([{ raw: [] }, { raw: ["", "a b", "safe; echo INJECTED"] }])(
  "argv-form raw splices exactly its elements: %j",
  async ({ raw }) => {
    const task = {
      cmd: [process.execPath, "-e", "console.log(JSON.stringify(process.argv.slice(1)))", "--", "{{ raw }}"],
    };
    const resolved = await Effect.runPromise(
      resolveToolingTaskShape(task, { raw }, authoredInvocationSites(task, "binding.yml")),
    );
    if (!Array.isArray(resolved.cmd)) throw new Error("expected argv");
    const child = spawn(resolved.cmd, { stdout: "pipe", stderr: "pipe" });
    expect(JSON.parse(await new Response(child.stdout).text())).toEqual(raw);
    expect(await child.exited).toBe(0);
  },
);

test("an empty raw executable is refused before dynamic evaluation", async () => {
  const task = { cmd: ["{{ raw }}"], vars: { V: { sh: "must-not-run" } } };
  const result = await Effect.runPromise(
    Effect.result(
      resolveToolingTaskShape(task, { raw: [] }, authoredInvocationSites(task, "binding.yml"), {
        name: "probe",
        evaluate: () => Effect.die("preflight must prevent execution"),
      }),
    ),
  );
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ToolingCompileError", message: expect.stringContaining("nonempty executable") },
  });
});

test.each(["{{ flags.value }} argument", "echo > {{ flags.value }}"])(
  "empty values stay words in command and redirection positions: %s",
  async (cmd) => {
    const resolved = await resolve(cmd, { flags: { value: "" } });
    expect(resolved.cmd).toBe(cmd.replace("{{ flags.value }}", "''"));
  },
);

test("boolean interpolations use lowercase and task identity is data", async () => {
  const resolved = await resolve(`${program} {{ flags.enabled }} {{ task.name }}`, {
    flags: { enabled: false },
    task: { name: "safe; echo INJECTED", subnamespace: "", commandNamespace: "app", canonicalId: "app:test" },
  });
  if (typeof resolved.cmd !== "string") throw new Error("expected command text");
  expect(await argv(resolved.cmd)).toEqual([
    ["false", "safe; echo INJECTED"],
    ["false", "safe; echo INJECTED"],
  ]);
});

test("event command leaves bind event payload as data", async () => {
  const command = `${program} {{ event.value }}`;
  const value = "safe; echo INJECTED";
  const resolved = await Effect.runPromise(
    resolveLeaf(
      {
        kind: "cmd",
        command,
        authoredIndex: 0,
        silent: false,
        ignoreError: false,
        invocationSites: authoredInvocationSites({ command }, "events.yml"),
      },
      { event: { value } },
    ),
  );
  if (resolved.leaf.kind !== "cmd") throw new Error("expected command leaf");
  expect(await argv(resolved.leaf.command)).toEqual([[value], [value]]);
});

test("hostile NUL-free values preserve argv under both shells (seed 2209)", async () => {
  const alphabet = ["'", '"', "$()", "`", "\n", ";", "&", "|", "#", "\\", " ", "Ω", "🦀", "abc"];
  let seed = 2209;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (let sample = 0; sample < 40; sample += 1) {
    const value = Array.from({ length: 1 + (next() % 20) }, () => alphabet[next() % alphabet.length]).join(
      "",
    );
    for (const site of ["{{ flags.value }}", '"{{ flags.value }}"', "'{{ flags.value }}'"]) {
      const resolved = await resolve(`${program} ${site}`, { flags: { value } });
      if (typeof resolved.cmd !== "string") throw new Error("expected command text");
      expect(await argv(resolved.cmd)).toEqual([[value], [value]]);
    }
  }
}, 20000);
