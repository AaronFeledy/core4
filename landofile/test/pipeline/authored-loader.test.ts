import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LandofileShape, ServiceName } from "@lando/sdk/schema";
import { Effect, References, Schema, Tracer } from "effect";
import { getSourceDocuments } from "../../src/pipeline/source-table.ts";
import { composeLandofileRootLayers, loadLandofileLayers } from "../../src/service.ts";
import * as validation from "../../src/validation.ts";
import { makeTestLandofilePorts, makeTestLandofileStateStore } from "../support.ts";

const withApp = async <T>(files: Readonly<Record<string, string>>, use: (root: string) => Promise<T>) => {
  const root = await mkdtemp(join(tmpdir(), "lando-authored-pipeline-"));
  try {
    for (const [file, content] of Object.entries(files)) await Bun.write(join(root, file), content);
    return await use(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};
const inputs = (root: string) => ({
  ports: makeTestLandofilePorts(root),
  stateStore: makeTestLandofileStateStore(),
  templates: { modules: [] },
});
const load = (root: string) => loadLandofileLayers(root, join(root, ".lando.yml"), inputs(root));

test.each([
  ["false", { disabled: true }],
  ["disabled", { disabled: true }],
  ["echo local", { cmd: "echo local" }],
])("a local YAML tooling shorthand %s replaces the inherited definition", async (higher, expected) => {
  // Given
  await withApp(
    {
      ".lando.yml": "name: forms\ntooling:\n  task:\n    service: web\n    cmds:\n      - echo inherited\n",
      ".lando.local.yml": `tooling:\n  task: ${higher}\n`,
    },
    async (root) => {
      // When
      const result = await Effect.runPromise(load(root));
      // Then
      expect(result.document.tooling?.task).toEqual(expected);
    },
  );
});

test("TypeScript Landofiles accept tooling shorthands", async () => {
  // Given
  await withApp(
    {
      ".lando.ts":
        "export default { name: 'forms', tooling: { off: false, retired: 'disabled', greet: 'echo hi' } }",
    },
    async (root) => {
      // When
      const result = await Effect.runPromise(
        loadLandofileLayers(root, join(root, ".lando.ts"), inputs(root)),
      );
      // Then
      expect(result.document.tooling).toEqual({
        off: { disabled: true },
        retired: { disabled: true },
        greet: { cmd: "echo hi" },
      });
    },
  );
});

test.each(["includes", "toolingIncludes"])(
  "a higher layer drops deferred vars when replacing a scalar task from %s",
  async (form) => {
    // Given
    const include =
      form === "includes"
        ? 'includes:\n  - source: ./tasks.yml\n    kind: tooling\n    namespace: ns\n    vars:\n      NAME: "{{ app.name }}"\n'
        : 'toolingIncludes:\n  ns:\n    file: ./tasks.yml\n    vars:\n      NAME: "{{ app.name }}"\n';
    await withApp(
      {
        ".lando.yml": `name: forms\n${include}`,
        "tasks.yml": 'tooling:\n  task: "echo {{ app.name }}"\n',
        ".lando.local.yml": "tooling:\n  ns:task:\n    cmd: echo local\n    service: :host\n",
      },
      async (root) => {
        // When
        const result = await Effect.runPromise(load(root));
        // Then
        expect(result.document.tooling?.["ns:task"]).toEqual({ cmd: "echo local", service: ":host" });
        expect(result.pendingSites).toEqual([]);
      },
    );
  },
);

test.each([
  ["environment", { KEEP: "lower" }, ["WIN=upper"], { WIN: "upper" }],
  ["environment", ["KEEP=lower"], { WIN: "upper" }, { WIN: "upper" }],
  ["labels", { KEEP: "lower" }, ["WIN=upper"], { WIN: "upper" }],
  ["labels", ["KEEP=lower"], { WIN: "upper" }, { WIN: "upper" }],
  ["appMount", { target: "/old", excludes: ["vendor"] }, "/new", { target: "/new" }],
  ["appMount", "/old", { target: "/new", excludes: ["vendor"] }, { target: "/new", excludes: ["vendor"] }],
  ["build", { context: "old", args: { OLD: "old" } }, "new", { context: "new" }],
  ["build", "old", { args: { WIN: "new" } }, { context: ".", args: { WIN: "new" } }],
  ["healthcheck", { command: "old", retries: 3 }, "new", { kind: "command", command: "new" }],
  ["healthcheck", "old", { retries: 7 }, { retries: 7 }],
  ["environment", { OLD: "old" }, [], {}],
])("composes authored %s forms before interpretation (%#)", async (field, lower, higher, expected) => {
  // Given
  await withApp(
    {
      ".lando.yml": "name: forms\n",
      ".lando.base.ts": `export default ${JSON.stringify({ services: { web: { [String(field)]: lower } } })}`,
      ".lando.local.ts": `export default ${JSON.stringify({ services: { web: { [String(field)]: higher } } })}`,
    },
    async (root) => {
      // When
      const result = await Effect.runPromise(load(root));
      // Then
      expect(Schema.encodeSync(LandofileShape)(result.document).services?.web).toEqual({
        [String(field)]: expected,
      });
    },
  );
});

test("one final runtime validation handles three layers and two partial fragments", async () => {
  // Given
  await withApp(
    {
      ".lando.base.yml": "services:\n  web:\n    build:\n      args:\n        KEEP: lower\n",
      ".lando.yml": "name: once\nincludes:\n  - first.yml\nservices:\n  web:\n    image: nginx\n",
      ".lando.local.yml": "services:\n  web:\n    primary: true\n",
      "first.yml": "includes:\n  - second.yml\nservices:\n  web:\n    build:\n      target: stage\n",
      "second.yml": "services:\n  web:\n    build:\n      context: ./site\n",
    },
    async (root) => {
      const calls = spyOn(validation, "validateLandofile");
      const spans: string[] = [];
      const tracer = Tracer.make({
        span(options) {
          spans.push(options.name);
          return new Tracer.NativeSpan(options);
        },
      });
      try {
        // When
        const result = await Effect.runPromise(
          load(root).pipe(
            Effect.provideService(Tracer.Tracer, tracer),
            Effect.provideService(References.TracerEnabled, true),
          ),
        );
        // Then
        expect(calls).toHaveBeenCalledTimes(1);
        expect(getSourceDocuments(result).map(({ file }) => file.slice(root.length + 1))).toEqual([
          ".lando.base.yml",
          "second.yml",
          "first.yml",
          ".lando.yml",
          ".lando.local.yml",
        ]);
        expect(
          getSourceDocuments(result).find(({ file }) => file.endsWith("first.yml"))?.document,
        ).toMatchObject({ includes: ["second.yml"] });
        expect(spans.filter((name) => name === "Landofile.finalize")).toHaveLength(1);
        expect(spans.filter((name) => name.includes("decodeLayer"))).toHaveLength(0);
        expect(result.document.services?.[ServiceName.make("web")]?.build).toEqual({
          context: "./site",
          target: "stage",
          args: { KEEP: "lower" },
        });
      } finally {
        calls.mockRestore();
      }
    },
  );
});

test.each([false, { disable: true }])(
  "only literal false is a three-layer reset barrier (%j)",
  async (middle) => {
    // Given
    await withApp(
      {
        ".lando.base.ts": `export default ${JSON.stringify({ services: { web: { healthcheck: { command: "lower" } } } })}`,
        ".lando.yml": "name: barrier\n",
        ".lando.dist.ts": `export default ${JSON.stringify({ services: { web: { healthcheck: middle } } })}`,
        ".lando.local.yml": "services:\n  web:\n    healthcheck:\n      disable: false\n      retries: 7\n",
      },
      async (root) => {
        // When
        const result = await Effect.runPromise(load(root));
        // Then
        expect(result.document.services?.[ServiceName.make("web")]?.healthcheck).toEqual(
          middle === false ? { retries: 7 } : { kind: "command", command: "lower", retries: 7 },
        );
      },
    );
  },
);

test("whole-value expressions replace inherited objects without a second merge or evaluation", async () => {
  // Given
  await withApp(
    {
      ".lando.yml": "name: expression\nservices:\n  web:\n    environment:\n      OLD: lower\n",
      ".lando.local.yml":
        "services:\n  web:\n    environment: \"{{ { WIN: 'new', LITERAL: env.LITERAL } }}\"\n",
    },
    async (root) => {
      // When
      const result = await Effect.runPromise(
        loadLandofileLayers(root, join(root, ".lando.yml"), {
          ...inputs(root),
          templates: {
            modules: [],
            context: { env: { LITERAL: "{{ env.NEVER }}" }, scope: "app", bootstrapLevel: "plugins" },
          },
        }),
      );
      // Then
      expect(result.document.services?.[ServiceName.make("web")]?.environment).toEqual({
        WIN: "new",
        LITERAL: "{{ env.NEVER }}",
      });
    },
  );
});

test("final issues retain alias spelling and local source", async () => {
  // Given
  await withApp(
    { ".lando.yml": "name: origin\n", ".lando.local.yml": "services:\n  web:\n    working_dir: 42\n" },
    async (root) => {
      // When
      const error = await Effect.runPromise(load(root).pipe(Effect.flip));
      // Then
      expect(error).toMatchObject({
        _tag: "LandofileValidationError",
        file: join(root, ".lando.local.yml"),
        issues: expect.arrayContaining([
          expect.objectContaining({
            source: {
              file: join(root, ".lando.local.yml"),
              layer: "local",
              path: ["services", "web", "working_dir"],
            },
          }),
        ]),
      });
    },
  );
});

test("authored composition remains available when final validation fails", async () => {
  // Given
  await withApp(
    {
      ".lando.yml": "name: inspect\nservices:\n  web:\n    primary: wrong\n",
      ".lando.local.yml": "services:\n  web:\n    image: nginx\n",
    },
    async (root) => {
      // When
      const result = await Effect.runPromise(composeLandofileRootLayers(root, inputs(root)));
      // Then
      expect(result.sources).toHaveLength(2);
      expect(result.merged).toMatchObject({ services: { web: { primary: "wrong", image: "nginx" } } });
    },
  );
});
