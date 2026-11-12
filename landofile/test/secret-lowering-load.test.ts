import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LandofileValidationError } from "@lando/sdk/errors";
import { Effect, Result } from "effect";
import { resolveLandofileLoadExpressions } from "../src/load-expression.ts";
import { DEFAULT_LANDOFILE_LOAD_POLICY } from "../src/load-expression-file.ts";
import { loadAuthoredDocuments } from "../src/root-compile.ts";
import { loadLandofileLayers } from "../src/service.ts";
import { makeTestLandofilePorts, makeTestLandofileStateStore } from "./support.ts";

const source = {
  appRoot: "/tmp/lando-secret-lowering",
  sourceRoot: "/tmp/lando-secret-lowering",
  sourcePath: "/tmp/lando-secret-lowering/.lando.yml",
  layer: "base" as const,
};

const load = (value: unknown) =>
  loadAuthoredDocuments([{ file: source.sourcePath, value }], {
    appRoot: source.appRoot,
    file: source.sourcePath,
  });

test.each([
  ["tooling cmd string", { tooling: { deploy: { cmd: "echo ${secret:A}" } } }, ["tooling", "deploy", "cmd"]],
  ["tooling string shorthand", { tooling: { deploy: "echo ${secret:A}" } }, ["tooling", "deploy", "cmd"]],
  [
    "tooling cmds string",
    { tooling: { deploy: { cmds: ["echo ${secret:A}"] } } },
    ["tooling", "deploy", "cmds", 0],
  ],
  [
    "tooling cmds object",
    { tooling: { deploy: { cmds: [{ cmd: "echo ${secret:A}" }] } } },
    ["tooling", "deploy", "cmds", 0, "cmd"],
  ],
  [
    "tooling var sh",
    { tooling: { deploy: { vars: { T: { sh: "echo ${secret:A}" } } } } },
    ["tooling", "deploy", "vars", "T", "sh"],
  ],
  ["event step shorthand", { events: { "post-start": ["echo ${secret:A}"] } }, ["events", "post-start", 0]],
  [
    "event step cmd",
    { events: { "post-start": [{ cmd: "echo ${secret:A}" }] } },
    ["events", "post-start", 0, "cmd"],
  ],
  [
    "event step defer",
    { events: { "post-start": [{ defer: "echo ${secret:A}" }] } },
    ["events", "post-start", 0, "defer"],
  ],
] as const)("%s loads and keeps the authored reference", async (_label, document, path) => {
  // When
  const compiled = await Effect.runPromise(load({ name: "probe", ...document }));
  // Then
  expect(compiled.pendingSites.map((site) => site.path)).toEqual([[...path]]);
  expect(JSON.stringify(compiled.document)).toContain("${secret:A}");
});

const refusals = [
  { name: "comment", command: "echo value # ${secret:A}", context: "a shell comment" },
  { name: "here-document", command: "cat <<EOF\n${secret:A}\nEOF", context: "a here-document" },
  { name: "backtick", command: "echo `printf %s ${secret:A}`", context: "a backtick" },
  { name: "arithmetic", command: "echo $((1 + ${secret:A}))", context: "arithmetic" },
  { name: "dollar-quote", command: "echo $'${secret:A}'", context: "quoted string" },
  { name: "escaped", command: "echo \\${secret:A}", context: "an escaped reference" },
  {
    name: "dollar before a line continuation",
    command: "echo $\\\n${secret:A} end",
    context: "an unescaped dollar sign",
  },
  {
    name: "case in a command substitution",
    command: 'echo "$(case x in x) echo ${secret:A};; esac)"',
    context: "a `case` statement",
  },
];

test.each(refusals)("refuses $name at load with site and context", async ({ command, context }) => {
  // When
  const failure = await Effect.runPromise(
    Effect.flip(
      resolveLandofileLoadExpressions({
        value: { name: "probe", tooling: { deploy: { cmd: command } } },
        source,
        policy: DEFAULT_LANDOFILE_LOAD_POLICY,
      }),
    ),
  );
  // Then
  expect(failure).toBeInstanceOf(LandofileValidationError);
  if (!(failure instanceof LandofileValidationError)) throw failure;
  expect(failure.issues).toMatchObject([
    { rule: "unsupported-secret-reference", path: ["tooling", "deploy", "cmd"] },
  ]);
  expect(failure.issues[0]?.message).toContain(context);
  expect(failure.issues[0]?.suggestion).toContain("tooling.deploy.env.A");
});

test("an escaped reference stays literal through the load walk", async () => {
  // When
  const compiled = await Effect.runPromise(
    load({ name: "probe", tooling: { deploy: { cmd: "echo '$${secret:A}'" } } }),
  );
  // Then
  expect(compiled.pendingSites).toEqual([]);
  expect(compiled.document.tooling?.deploy).toMatchObject({ cmd: "echo '${secret:A}'" });
});

test.each([
  [{ services: { app: { command: "echo ${secret:A}" } } }, ["services", "app", "command"]],
  [{ services: { app: { build: { app: "echo ${secret:A}" } } } }, ["services", "app", "build", "app"]],
  [{ tooling: { deploy: { cmd: ["echo", "${secret:A}"] } } }, ["tooling", "deploy", "cmd", 1]],
  [{ events: { "post-start": [{ task: "echo ${secret:A}" }] } }, ["events", "post-start", 0, "task"]],
] as const)("still rejects a deferred command site outside D1: %j", async (document, path) => {
  // When
  const result = await Effect.runPromise(
    Effect.result(
      resolveLandofileLoadExpressions({
        value: { name: "probe", ...document },
        source,
        policy: DEFAULT_LANDOFILE_LOAD_POLICY,
      }),
    ),
  );
  // Then
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) {
    expect(result.failure).toBeInstanceOf(LandofileValidationError);
    if (result.failure instanceof LandofileValidationError)
      expect(result.failure.issues[0]).toMatchObject({ rule: "unsupported-secret-reference", path });
  }
});

test("include fragments, conditional bodies, and tooling fragments admit D1 sites", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-secret-lowering-"));
  try {
    await writeFile(
      join(root, ".lando.yml"),
      "name: probe\nincludes:\n  - source: ./fragment.yml\n    when: true\ntoolingIncludes:\n  extra:\n    file: ./task.yml\n",
    );
    await writeFile(join(root, "fragment.yml"), 'tooling:\n  deploy:\n    cmd: "echo ${secret:A}"\n');
    await writeFile(join(root, "task.yml"), 'tooling:\n  hello:\n    cmd: "echo ${secret:B}"\n');
    // When
    const compiled = await Effect.runPromise(
      loadLandofileLayers(root, join(root, ".lando.yml"), {
        ports: makeTestLandofilePorts(join(root, "cache"), join(root, "includes")),
        stateStore: makeTestLandofileStateStore(),
        templates: { modules: [] },
      }),
    );
    // Then
    const paths = compiled.pendingSites.map((site) => site.path);
    expect(paths).toHaveLength(2);
    expect(paths).toEqual(
      expect.arrayContaining([
        ["tooling", "deploy", "cmd"],
        ["tooling", "extra:hello", "cmd"],
      ]),
    );
    expect(JSON.stringify(compiled.document)).toContain("${secret:A}");
    expect(JSON.stringify(compiled.document)).toContain("${secret:B}");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
