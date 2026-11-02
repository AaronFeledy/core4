import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LandofileValidationError } from "@lando/sdk/errors";
import { override, reset } from "@lando/sdk/landofile";
import { Effect, Result } from "effect";
import { DEFAULT_LANDOFILE_LOAD_POLICY } from "../src/load-expression-file.ts";
import { resolveLandofileLoadExpressions } from "../src/load-expression.ts";
import {
  loadTestLandofileFile as loadLandofileFile,
  loadTestLandofileLayers as loadLandofileLayers,
} from "./support.ts";
import { makeTestLandofilePorts, makeTestLandofileStateStore } from "./support.ts";

const source = {
  appRoot: "/tmp/authoring-policy",
  sourceRoot: "/tmp/authoring-policy",
  sourcePath: "/tmp/authoring-policy/.lando.base.yml",
  layer: "base" as const,
};
const resolve = (value: unknown) =>
  resolveLandofileLoadExpressions({ value, source, policy: DEFAULT_LANDOFILE_LOAD_POLICY });

test.each([
  [{ services: { web: { command: ["echo", "${HOME}"] } } }, ["services", "web", "command", 1]],
  [{ services: { web: { command: override(["${HOME}"]) } } }, ["services", "web", "command", 0]],
  [{ "x-${HOME}": "inert" }, ["x-${HOME}"]],
  [{ "{{ load('./missing') }}": "inert" }, ["{{ load('./missing') }}"]],
  [{ tooling: { test: { cmd: "echo ${HOME}" } } }, ["tooling", "test", "cmd"]],
  [{ services: { web: { command: "prefix-${secret:TEST}" } } }, ["services", "web", "command"]],
] as const)("rejects active authored syntax at its member path: %j", async (value, path) => {
  // Given / When
  const result = await Effect.runPromise(Effect.result(resolve(value)));
  // Then
  expect(Result.isFailure(result)).toBe(true);
  if (!Result.isFailure(result)) throw new Error("Expected authored policy failure");
  expect(result.failure).toBeInstanceOf(LandofileValidationError);
  if (!(result.failure instanceof LandofileValidationError)) throw result.failure;
  expect(result.failure.issues).toMatchObject([
    { path, rule: "unsupported-expression", source: { file: source.sourcePath, layer: "base", path } },
  ]);
  expect(result.failure.issues[0]?.suggestion).toBeString();
});

test.each([
  [".lando.yml", "name: integrity\ntooling:\n  task:\n    cmd: echo ${HOME}\n", "canonical"],
  [".lando.base.yml", 'tooling:\n  task:\n    cmd: !override "echo ${HOME}"\n', "base"],
  ["fragment.yml", "tooling:\n  task:\n    cmd: echo ${HOME}\n", "canonical"],
  ["tasks.yml", "tooling:\n  task:\n    cmd: echo ${HOME}\n", "canonical"],
] as const)("retains authored policy source attribution from %s", async (filename, content, layer) => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-authoring-source-"));
  try {
    const includes =
      filename === "fragment.yml"
        ? "includes: [./fragment.yml]\n"
        : filename === "tasks.yml"
          ? "includes:\n  - source: ./tasks.yml\n    kind: tooling\n    namespace: tasks\n"
          : "";
    await writeFile(join(root, ".lando.yml"), `name: integrity\n${includes}`);
    await writeFile(join(root, filename), content);
    // When
    const result = await Effect.runPromise(
      Effect.result(
        loadLandofileLayers(root, join(root, ".lando.yml"), {
          ports: makeTestLandofilePorts(join(root, "cache"), join(root, "includes")),
          stateStore: makeTestLandofileStateStore(),
          templates: { modules: [] },
        }),
      ),
    );
    // Then
    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) throw new Error("Expected authored source failure");
    expect(result.failure).toMatchObject({
      _tag: "LandofileValidationError",
      issues: [
        {
          path: ["tooling", "task", "cmd"],
          source: {
            file: join(root, filename),
            layer,
            path: ["tooling", "task", "cmd"],
          },
        },
      ],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loads unquoted shell escapes without a file-wide load/import bypass and discards reset syntax", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-authoring-escape-"));
  try {
    const file = join(root, ".lando.yml");
    await writeFile(
      file,
      [
        "name: integrity",
        "services:",
        "  web:",
        "    command: echo $${HOME}",
        "    environment:",
        "      TOKEN: $${secret:TEST}",
        'tooling: !reset "{{ invalid syntax ${HOME}"',
      ].join("\n"),
    );
    // When
    const loaded = await Effect.runPromise(loadLandofileFile(file));
    // Then
    expect(loaded).toMatchObject({
      services: {
        web: {
          command: "echo ${HOME}",
          environment: { TOKEN: "${secret:TEST}" },
        },
      },
    });
    expect(loaded.tooling).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves escapes, bare shell parameters, genuine environment secrets and reset payloads", async () => {
  // Given
  const value = {
    services: { web: { command: "echo $HOME $${HOME}", environment: { TOKEN: "${secret:TEST}" } } },
    "x-reset": reset(),
    "x-literal": "{{{{ not an expression",
  };
  // When
  const result = await Effect.runPromise(resolve(value));
  // Then
  expect(result.value).toEqual({
    ...value,
    services: { web: { ...value.services.web, command: "echo $HOME ${HOME}" } },
    "x-literal": "{{ not an expression",
  });
});
