import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { loadLandofileLayers } from "../src/service.ts";
import { getLandofileValueSource } from "../src/validation.ts";
import { makeTestLandofilePorts, makeTestLandofileStateStore } from "./support.ts";

const withApp = async (files: Readonly<Record<string, string>>, check: (root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "lando-include-defaults-"));
  try {
    for (const [name, text] of Object.entries(files)) await Bun.write(join(root, name), text);
    await check(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};
const load = (root: string) =>
  Effect.runPromise(
    loadLandofileLayers(root, join(root, ".lando.yml"), {
      ports: makeTestLandofilePorts(root),
      stateStore: makeTestLandofileStateStore(),
      templates: { modules: [] },
    }),
  );
const include = (form: string) =>
  form === "includes"
    ? "includes:\n  - source: ./tasks.yml\n    kind: tooling\n    namespace: ns\n    vars:\n      KEEP: include\n      DROP: include\n"
    : "toolingIncludes:\n  ns:\n    file: ./tasks.yml\n    vars:\n      KEEP: include\n      DROP: include\n";

for (const form of ["includes", "toolingIncludes"]) {
  test(`${form} tasks are inherited values a higher tooling: !override replaces`, async () => {
    // Given
    await withApp(
      {
        ".lando.yml": `name: defaults\n${include(form)}tooling:\n  inline:\n    cmd: echo base\n`,
        "tasks.yml": "tooling:\n  task: echo included\n",
        ".lando.local.yml": "tooling: !override\n  other:\n    cmd: echo local\n",
      },
      async (root) => {
        // When
        const compiled = await load(root);
        // Then
        expect(Object.keys(compiled.document.tooling ?? {})).toEqual(["other"]);
      },
    );
  });
  test.each(["false", "\n    cmd: echo retained\n    disabled: true"])(
    `${form} retains the fragment's disabled origin for %s`,
    async (task) => {
      await withApp(
        {
          ".lando.yml": `name: defaults\n${include(form)}`,
          "tasks.yml": `tooling:\n  task: ${task}\n`,
          ".lando.local.yml":
            task === "false" ? "name: defaults\n" : "tooling:\n  ns:task:\n    description: local metadata\n",
        },
        async (root) => {
          const compiled = await load(root);
          expect(compiled.document.tooling?.["ns:task"]?.disabled).toBe(true);
          expect(getLandofileValueSource(compiled.document, ["tooling", "ns:task", "disabled"])?.file).toBe(
            join(root, "tasks.yml"),
          );
        },
      );
    },
  );
  test.each([
    ["single reset", "\n      DROP: !reset", { KEEP: "include" }],
    ["single override", "\n      DROP: !override local", { KEEP: "include", DROP: "local" }],
    ["whole reset", " !reset", undefined],
    ["whole override", " !override\n      OWN: local", { OWN: "local" }],
  ])(`${form} composes include-level vars with %s`, async (_case, vars, expected) => {
    const local =
      form === "includes"
        ? `includes:\n  - source: ./tasks.yml\n    kind: tooling\n    namespace: ns\n    vars:${vars}\n`
        : `toolingIncludes:\n  ns:\n    file: ./tasks.yml\n    vars:${vars}\n`;
    await withApp(
      {
        ".lando.yml": `name: defaults\n${include(form)}`,
        "tasks.yml": "tooling:\n  task:\n    cmd: included\n",
        ".lando.local.yml": local,
      },
      async (root) => {
        const compiled = await load(root);
        expect(compiled.document.tooling?.["ns:task"]?.vars).toEqual(expected);
      },
    );
  });
  test.each([
    ["object merge", "\n    description: local", { KEEP: "include", DROP: "include" }],
    ["single reset", "\n    vars:\n      DROP: !reset", { KEEP: "include" }],
    ["single override", "\n    vars:\n      DROP: !override local", { KEEP: "include", DROP: "local" }],
    ["vars reset", "\n    vars: !reset", undefined],
    ["vars override", "\n    vars: !override\n      OWN: local", { OWN: "local" }],
    ["task override", " !override\n    cmd: local", undefined],
    ["scalar replacement", " echo local", undefined],
  ])(`${form} honors %s without resurrecting defaults`, async (_case, overlay, vars) => {
    await withApp(
      {
        ".lando.yml": `name: defaults\n${include(form)}`,
        "tasks.yml": "tooling:\n  task:\n    cmd: included\n",
        ".lando.local.yml": `tooling:\n  ns:task:${overlay}\n`,
      },
      async (root) => {
        const compiled = await load(root);
        expect(compiled.document.tooling?.["ns:task"]?.vars).toEqual(vars);
      },
    );
  });

  test.each([
    ["task: !reset", "tooling:\n  ns:task: !reset\n"],
    ["task: !override", "tooling:\n  ns:task: !override\n    cmd: local\n"],
    ["scalar then object", "tooling:\n  ns:task: echo local\n"],
    ["tooling: !reset", "tooling: !reset\n"],
    ["tooling: !override", "tooling: !override\n  ns:task:\n    cmd: local\n"],
    ["vars: !reset", "tooling:\n  ns:task:\n    vars: !reset\n"],
    ["vars: !override", "tooling:\n  ns:task:\n    vars: !override {}\n"],
  ])(`${form} retains consumed %s history through a later object layer`, async (_case, middle) => {
    await withApp(
      {
        ".lando.yml": `name: defaults\n${include(form)}`,
        "tasks.yml": "tooling:\n  task:\n    cmd: included\n",
        ".lando.local.yml": middle,
        ".lando.user.yml": "tooling:\n  ns:task:\n    cmd: final\n    vars:\n      OWN: final\n",
      },
      async (root) => {
        const compiled = await load(root);
        expect(compiled.document.tooling?.["ns:task"]?.vars).toEqual({ OWN: "final" });
      },
    );
  });

  test(`${form} preserves only surviving default sites and sources after a deep merge`, async () => {
    await withApp(
      {
        ".lando.yml": `name: defaults\n${include(form).replace("KEEP: include", 'KEEP: "{{ event.KEEP }}"').replace("DROP: include", 'DROP: "{{ event.DROP }}"')}`,
        "tasks.yml": 'tooling:\n  task:\n    cmd: "echo {{ event.CMD }}"\n',
        ".lando.local.yml": "tooling:\n  ns:task:\n    description: local\n    vars:\n      DROP: !reset\n",
      },
      async (root) => {
        const compiled = await load(root);
        expect(compiled.pendingSites.map(({ path }) => path)).toEqual([
          ["tooling", "ns:task", "cmd"],
          ["tooling", "ns:task", "vars", "KEEP"],
        ]);
        expect(getLandofileValueSource(compiled.document, ["tooling", "ns:task", "vars", "KEEP"])?.file).toBe(
          join(root, ".lando.yml"),
        );
        expect(getLandofileValueSource(compiled.document, ["tooling", "ns:task", "vars", "DROP"])?.file).toBe(
          join(root, ".lando.local.yml"),
        );
      },
    );
  });
}

test.each(["echo included", "\n    cmd: echo included"])(
  "nested defaults, aliases and excludes preserve precedence for %s",
  async (task) => {
    await withApp(
      {
        ".lando.yml":
          "name: defaults\ntoolingIncludes:\n  outer:\n    file: ./outer.yml\n    aliases: [alias]\n    excludes: [inner:excluded]\n    vars:\n      OUTER: outer\n      INNER: outer\n      OWN: outer\n",
        "outer.yml":
          "toolingIncludes:\n  inner:\n    file: ./tasks.yml\n    vars:\n      INNER: inner\n      OWN: inner\n",
        "tasks.yml": `tooling:\n  task: ${task}\n  excluded: echo excluded\n  owned:\n    cmd: echo owned\n    vars:\n      OWN: task\n`,
      },
      async (root) => {
        const compiled = await load(root);
        expect(Object.keys(compiled.document.tooling ?? {})).toEqual([
          "outer:inner:task",
          "alias:inner:task",
          "outer:inner:owned",
          "alias:inner:owned",
        ]);
        expect(compiled.document.tooling?.["alias:inner:task"]?.vars).toEqual({
          OUTER: "outer",
          INNER: "inner",
          OWN: "inner",
        });
        expect(compiled.document.tooling?.["outer:inner:owned"]?.vars).toEqual({
          OUTER: "outer",
          INNER: "inner",
          OWN: "task",
        });
      },
    );
  },
);

test.each([
  ["\n      DROP: !reset\n      KEEP: inner", { KEEP: "inner" }],
  [" !reset", undefined],
  [" !override\n      KEEP: inner", { KEEP: "inner" }],
])("nested include vars %s do not resurrect outer defaults", async (vars, expected) => {
  await withApp(
    {
      ".lando.yml":
        "name: defaults\ntoolingIncludes:\n  outer:\n    file: ./outer.yml\n    vars:\n      DROP: outer\n      KEEP: outer\n",
      "outer.yml": `toolingIncludes:\n  inner:\n    file: ./tasks.yml\n    vars:${vars}\n`,
      "tasks.yml": "tooling:\n  task: echo included\n",
    },
    async (root) => {
      const compiled = await load(root);
      expect(compiled.document.tooling?.["outer:inner:task"]?.vars).toEqual(expected);
    },
  );
});
