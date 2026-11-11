import { expect, test } from "bun:test";
import { override, reset } from "@lando/sdk/landofile";
import { unsupportedSecretReference } from "../src/unsupported-secret-reference.ts";

const source = { file: ".lando.yml", layer: "base" as const, path: ["tooling", "deploy", "cmd"] };

test("fixes every distinct reference together while retaining repeated occurrences", () => {
  const value = "deploy ${secret:A} ${secret:B} ${secret:A}";
  const result = unsupportedSecretReference({
    source,
    value,
    references: ["A", "B", "A"],
    document: { tooling: { deploy: { cmd: value } } },
  });
  expect(result).toEqual({
    message: "Secret references are not supported at tooling.deploy.cmd.",
    suggestion:
      "Set tooling.deploy.env.A and tooling.deploy.env.B to the ${secret:...} references and write $A and $B in the command. The shell reads it when the task runs.",
    fix: {
      edits: [
        { op: "set", path: ["tooling", "deploy", "env", "A"], value: "${secret:A}" },
        { op: "set", path: ["tooling", "deploy", "env", "B"], value: "${secret:B}" },
        { op: "set", path: source.path, value: 'deploy "$A" "$B" "$A"' },
      ],
    },
  });
});

test("deduplicates generated names and never binds reserved names", () => {
  const value = "deploy ${secret:LANDO} ${secret:LANDO_TOKEN} ${secret:SECRET} ${secret:db.pass}";
  const result = unsupportedSecretReference({
    source,
    value,
    references: ["LANDO", "LANDO_TOKEN", "SECRET", "db.pass"],
    document: { tooling: { deploy: { cmd: value } } },
  });
  expect(result.fix?.edits).toEqual([
    { op: "set", path: ["tooling", "deploy", "env", "SECRET"], value: "${secret:LANDO}" },
    { op: "set", path: ["tooling", "deploy", "env", "SECRET_2"], value: "${secret:LANDO_TOKEN}" },
    { op: "set", path: ["tooling", "deploy", "env", "SECRET_3"], value: "${secret:SECRET}" },
    { op: "set", path: ["tooling", "deploy", "env", "SECRET_4"], value: "${secret:db.pass}" },
    { op: "set", path: source.path, value: 'deploy "$SECRET" "$SECRET_2" "$SECRET_3" "$SECRET_4"' },
  ]);
});

test.each([{ env: ["TOKEN=other"] }, { env: "bad" }, { env: { TOKEN: "other" } }])(
  "omits incomplete fixes when an environment would be overwritten: %j",
  (task) => {
    const result = unsupportedSecretReference({
      source,
      value: "echo ${secret:TOKEN}",
      references: ["TOKEN"],
      document: { tooling: { deploy: { cmd: "echo ${secret:TOKEN}", ...task } } },
    });
    expect(result.fix).toBeUndefined();
  },
);

test("keeps an existing identical binding instead of setting it again", () => {
  const result = unsupportedSecretReference({
    source,
    value: "echo ${secret:TOKEN}",
    references: ["TOKEN"],
    document: { tooling: { deploy: { env: { TOKEN: "${secret:TOKEN}" }, cmd: "echo ${secret:TOKEN}" } } },
  });
  expect(result.fix).toEqual({ edits: [{ op: "set", path: source.path, value: 'echo "$TOKEN"' }] });
});

test("converts event shorthand with separate binding edits", () => {
  const path = ["events", "post-start", 0];
  const document = { events: { "post-start": ["echo ${secret:TOKEN}"] } };
  const result = unsupportedSecretReference({
    source: { ...source, path },
    document,
    value: "echo ${secret:TOKEN}",
    references: ["TOKEN"],
  });
  expect(result.fix).toEqual({
    edits: [
      { op: "set", path, value: { cmd: 'echo "$TOKEN"' } },
      { op: "set", path: [...path, "env", "TOKEN"], value: "${secret:TOKEN}" },
    ],
  });
});

test.each([
  {
    type: "lando",
    fix: {
      edits: [
        { op: "set", path: ["services", "app", "environment", "TOKEN"], value: "${secret:TOKEN}" },
        { op: "set", path: ["services", "app", "command"], value: 'echo "$TOKEN"' },
      ],
    },
  },
  { type: "compose", fix: undefined },
  { type: "{{ env.SERVICE_TYPE }}", fix: undefined },
  { type: undefined, fix: undefined },
])("only fixes a known shell service command for $type", ({ type, fix }) => {
  const result = unsupportedSecretReference({
    source: { ...source, path: ["services", "app", "command"] },
    value: "echo ${secret:TOKEN}",
    references: ["TOKEN"],
    document: { services: { app: { type } } },
  });
  expect(result.fix).toEqual(fix);
});

test.each([
  {
    value: "echo $${secret:TOKEN} ${secret:TOKEN}",
    references: ["TOKEN"],
    expected: {
      edits: [
        { op: "set", path: ["tooling", "deploy", "env", "TOKEN"], value: "${secret:TOKEN}" },
        { op: "set", path: source.path, value: 'echo $${secret:TOKEN} "$TOKEN"' },
      ],
    },
  },
  { value: "echo ${secret:TOKEN} ${secret:OTHER}", references: ["TOKEN"], expected: undefined },
  { value: "echo ${secret:TOKEN} {{", references: ["TOKEN"], expected: undefined },
])("only fixes completely reparsable replacements: $value", ({ value, references, expected }) => {
  const result = unsupportedSecretReference({ source, value, references, document: {} });
  expect(result.fix).toEqual(expected);
});

test.each([
  {
    name: "double quotes keep the expansion unquoted",
    value: 'echo "${secret:TOKEN}"',
    expected: 'echo "$TOKEN"',
  },
  {
    name: "an unquoted identifier suffix is separated by the added quote",
    value: "echo pre${secret:TOKEN}post",
    expected: 'echo pre"$TOKEN"post',
  },
  {
    name: "a quoted identifier suffix still changes the variable",
    value: 'echo "pre${secret:TOKEN}post"',
    expected: undefined,
  },
  {
    name: "a here-document body would not expand",
    value: "cat <<EOF\n${secret:TOKEN}\nEOF",
    expected: undefined,
  },
  {
    name: "a quoted here-document body stays literal",
    value: "cat <<'EOF'\n${secret:TOKEN}\nEOF",
    expected: undefined,
  },
  {
    name: "an indented here-document is still a here-document",
    value: "cat <<-EOF\n${secret:TOKEN}\nEOF",
    expected: undefined,
  },
  { name: "a here-string expands its own way", value: "cat <<< ${secret:TOKEN}", expected: undefined },
  {
    name: "a command substitution restarts quoting",
    value: 'echo "$(printf %s "${secret:TOKEN}")"',
    expected: undefined,
  },
  { name: "backticks restart quoting", value: 'echo "`printf %s ${secret:TOKEN}`"', expected: undefined },
  {
    name: "a line continuation extends the name even after a quote closes",
    value: 'printf %s "${secret:TOKEN}\\\nB"',
    expected: undefined,
  },
  {
    name: "a quote inside a comment is not quoting syntax",
    value: 'echo hi # don"t\nprintf %s ${secret:TOKEN}',
    expected: undefined,
  },
  {
    name: "a comment after the last reference does not block the fix",
    value: 'printf %s ${secret:TOKEN} # don"t',
    expected: 'printf %s "$TOKEN" # don"t',
  },
])("rewrites only quoting contexts that keep the expansion exact: $name", ({ value, expected }) => {
  const result = unsupportedSecretReference({ source, value, references: ["TOKEN"], document: {} });
  if (expected === undefined) expect(result.fix).toBeUndefined();
  expect(result.fix?.edits.at(-1)?.value).toEqual(expected);
});

test.each([
  { name: "assigns the chosen name first", value: "A=public; printf %s ${secret:A}" },
  { name: "reads the chosen name elsewhere", value: "echo $A; printf %s ${secret:A}" },
])("withholds a fix when the command already uses the chosen name: $name", ({ value }) => {
  const result = unsupportedSecretReference({ source, value, references: ["A"], document: {} });
  expect(result.fix).toBeUndefined();
});

test("never binds a prototype key as a generated name", () => {
  const result = unsupportedSecretReference({
    source,
    value: "echo ${secret:__proto__}",
    references: ["__proto__"],
    document: {},
  });
  expect(result.fix).toEqual({
    edits: [
      { op: "set", path: ["tooling", "deploy", "env", "SECRET"], value: "${secret:__proto__}" },
      { op: "set", path: source.path, value: 'echo "$SECRET"' },
    ],
  });
});

test.each([
  [
    ["services", "app", "build", "app"],
    ["services", "app", "environment"],
  ],
  [
    ["services", "app", "build", "app", "run"],
    ["services", "app", "environment"],
  ],
  [
    ["services", "app", "build", "app", 0],
    ["services", "app", "environment"],
  ],
  [
    ["services", "app", "build", "app", 0, "run"],
    ["services", "app", "environment"],
  ],
  [
    ["tooling", "deploy", "cmds", 0],
    ["tooling", "deploy", "env"],
  ],
  [
    ["tooling", "deploy", "cmds", 0, "cmd"],
    ["tooling", "deploy", "cmds", 0, "env"],
  ],
  [
    ["events", "post-start", 0, "cmd"],
    ["events", "post-start", 0, "env"],
  ],
  [
    ["events", "post-start", 0, "defer"],
    ["events", "post-start", 0, "env"],
  ],
] as const)("targets the environment actually inherited at %j", (path, parent) => {
  const result = unsupportedSecretReference({
    source: { ...source, path },
    document: {},
    value: "echo ${secret:TOKEN}",
    references: ["TOKEN"],
  });
  expect(result.fix).toEqual({
    edits: [
      { op: "set", path: [...parent, "TOKEN"], value: "${secret:TOKEN}" },
      { op: "set", path, value: 'echo "$TOKEN"' },
    ],
  });
});

test.each([
  [["tooling", "deploy"]],
  [["services", "app", "entrypoint"]],
  [["services", "app", "command", 0]],
  [["tooling", "deploy", "cmd", 0]],
  [["services", "app", "build", "args", "TOKEN"]],
  [["services", "app", "build", "artifact", "run"]],
  [["services", "app", "build", "dockerfileInline"]],
  [["services", "app", "healthcheck"]],
  [["tooling", "deploy", "vars", "token", "sh"]],
  [["events", "post-start", 0, "command"]],
  [["services", "app", "image"]],
  [["services", "app", "build", "app", "user"]],
] as const)("never guesses an executable fix for %j", (path) => {
  const result = unsupportedSecretReference({
    source: { ...source, path },
    document: {},
    value: "echo ${secret:TOKEN}",
    references: ["TOKEN"],
  });
  expect(result.fix).toBeUndefined();
});

test("does not emit fixes without the authored document", () => {
  const result = unsupportedSecretReference({ source, value: "echo ${secret:TOKEN}", references: ["TOKEN"] });
  expect(result.fix).toBeUndefined();
});

test("reads the authored service type and bindings through merge directives", () => {
  const result = unsupportedSecretReference({
    source: { ...source, path: ["services", "app", "command"] },
    defaultServiceType: "compose",
    value: "echo ${secret:TOKEN}",
    references: ["TOKEN"],
    document: override({
      services: override({
        app: override({
          type: override("node"),
          environment: override({ TOKEN: override("${secret:TOKEN}") }),
        }),
      }),
    }),
  });
  expect(result.fix?.edits).toEqual([
    { op: "set", path: ["services", "app", "command"], value: 'echo "$TOKEN"' },
  ]);
});

test("does not fix a binding parent removed with a reset directive", () => {
  const result = unsupportedSecretReference({
    source,
    value: "echo ${secret:TOKEN}",
    references: ["TOKEN"],
    document: { tooling: { deploy: { env: reset() } } },
  });
  expect(result.fix).toBeUndefined();
});

test("omits a service fix when its environment is authored as a list", () => {
  const result = unsupportedSecretReference({
    source: { ...source, path: ["services", "app", "command"] },
    value: "echo ${secret:TOKEN}",
    references: ["TOKEN"],
    document: { services: { app: { type: "node", environment: ["OTHER=1"] } } },
  });
  expect(result.fix).toBeUndefined();
});
