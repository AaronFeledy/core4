import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LandofileValidationError } from "@lando/sdk/errors";
import { override, reset } from "@lando/sdk/landofile";
import { Effect, Result } from "effect";
import { resolveLandofileLoadExpressions } from "../src/load-expression.ts";
import { DEFAULT_LANDOFILE_LOAD_POLICY } from "../src/load-expression-file.ts";
import {
  loadTestLandofileFile as loadLandofileFile,
  loadTestLandofileLayers as loadLandofileLayers,
  makeTestLandofilePorts,
  makeTestLandofileStateStore,
} from "./support.ts";

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
  [{ services: { app: { build: { args: { TOKEN: "${secret:TOKEN}" } } } } }, "TOKEN"],
  [{ services: { app: { build: { args: ["TOKEN=prefix-${secret:TOKEN}"] } } } }, 0],
] as const)("rejects a build argument secret with image-history guidance: %j", async (value, key) => {
  // Given
  const path = ["services", "app", "build", "args", key];
  const message = `Secret references are not supported at ${path.join(".")}. Build arguments can be recorded in image history.`;
  const suggestion =
    "For runtime use, set services.app.environment.TOKEN to the ${secret:...} reference. For setup that needs it, add an events.post-start step with service app, env.TOKEN set to the reference, and $TOKEN in its cmd; it runs in the started container.";
  // When
  const failure = await Effect.runPromise(resolve(value).pipe(Effect.flip));
  // Then
  expect(failure).toBeInstanceOf(LandofileValidationError);
  expect(failure).toMatchObject({
    file: source.sourcePath,
    message,
    remediation: suggestion,
    issues: [
      {
        path,
        rule: "unsupported-secret-reference",
        message,
        suggestion,
        source: { file: source.sourcePath, layer: "base", path },
      },
    ],
  });
});

test.each([
  ["prefix-${secret:TEST}", "TEST"],
  ["${HOME}-${secret:TOKEN}", "TOKEN"],
])(
  "rejects an unauthorized secret with secret-specific guidance, even beside a shell parameter: %s",
  async (command, name) => {
    // Given
    const value = { services: { web: { command } } };
    // When
    const failure = await Effect.runPromise(resolve(value).pipe(Effect.flip));
    // Then
    expect(failure).toMatchObject({
      _tag: "LandofileValidationError",
      message: "Secret references are not supported at services.web.command.",
      remediation: `Set services.web.environment.${name} to the \${secret:...} reference. Write $${name} in the command when the service type runs that string as a shell script. On type: compose, the string is split into arguments and is not a shell, so write sh -c with $${name} inside one quoted argument.`,
      issues: [{ path: ["services", "web", "command"], rule: "unsupported-secret-reference" }],
    });
  },
);

test.each([
  [
    { services: { app: { build: { app: "fetch ${secret:TOKEN}" } } } },
    ["services", "app", "build", "app"],
    "Set services.app.environment.TOKEN",
  ],
  [
    { services: { app: { build: { artifact: { run: "fetch ${secret:TOKEN}" } } } } },
    ["services", "app", "build", "artifact", "run"],
    "Move this step to services.app.build.app",
  ],
  [
    { tooling: { deploy: "deploy ${secret:TOKEN}" } },
    ["tooling", "deploy"],
    "Use the object form: set tooling.deploy.cmd",
  ],
  [
    { services: { app: { entrypoint: "/start ${secret:TOKEN}" } } },
    ["services", "app", "entrypoint"],
    "Set services.app.environment.TOKEN",
  ],
  [
    { services: { app: { build: { dockerfile_inline: "FROM node\nRUN fetch ${secret:TOKEN}" } } } },
    ["services", "app", "build", "dockerfile_inline"],
    "For runtime use, set services.app.environment.TOKEN",
  ],
  [
    { events: { "post-stop": [{ defer: "notify ${secret:TOKEN}" }] } },
    ["events", "post-stop", 0, "defer"],
    "Set events.post-stop.0.env.TOKEN",
  ],
] as const)(
  "reports the authored shorthand path for site-aware guidance: %j",
  async (value, path, suggestion) => {
    // Given / When
    const failure = await Effect.runPromise(resolve(value).pipe(Effect.flip));
    // Then
    expect(failure).toMatchObject({
      _tag: "LandofileValidationError",
      issues: [{ path, rule: "unsupported-secret-reference" }],
    });
    if (!(failure instanceof LandofileValidationError)) throw failure;
    expect(failure.issues[0]?.suggestion).toStartWith(suggestion);
  },
);

test("decodes an escaped build argument secret as literal text through the full loader", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-build-arg-escape-"));
  try {
    const file = join(root, ".lando.yml");
    await writeFile(
      file,
      'name: literal\nservices:\n  app:\n    type: node\n    build:\n      context: .\n      args:\n        TOKEN: "$${secret:TOKEN}"\n',
    );
    // When
    const loaded = await Effect.runPromise(loadLandofileLayers(root, file));
    // Then
    expect(loaded).toMatchObject({ services: { app: { build: { args: { TOKEN: "${secret:TOKEN}" } } } } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps loaded secret-shaped text in a build argument as literal data", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-build-arg-loaded-"));
  try {
    const file = join(root, ".lando.yml");
    await writeFile(join(root, "token.txt"), "${secret:TOKEN}");
    await writeFile(
      file,
      "name: loaded\nservices:\n  app:\n    type: node\n    build:\n      context: .\n      args:\n        TOKEN: \"{{ load('./token.txt') }}\"\n",
    );
    // When
    const loaded = await Effect.runPromise(loadLandofileLayers(root, file));
    // Then
    expect(loaded).toMatchObject({ services: { app: { build: { args: { TOKEN: "${secret:TOKEN}" } } } } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
