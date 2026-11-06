import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plugin } from "@lando/lando4";
import { Effect } from "effect";
import { prepareInitApp } from "../../src/cli/commands/init-preparation.ts";
import { runPostInit } from "../../src/recipes/post-init/runtime.ts";
import { prepareRecipeInit } from "../../src/recipes/prepared-init.ts";
import { ownerOnlyFileAccess } from "../_support/private-file-access.ts";
import { compileTestSource, testSource } from "./fixtures/prepared-source.ts";

test.each(["false", false])(
  "preserves typed condition value %j through selection and execution",
  async (value) => {
    const root = await mkdtemp(join(tmpdir(), "prepared-conditions-"));
    try {
      const compiled = await compileTestSource(
        {
          ...testSource,
          options: { value: { type: { kind: "enum", values: ["false", false] } } },
          variants: [
            { when: 'eq(options.value, "false")', config: { "x-selected": "string" } },
            { when: "eq(options.value, false)", config: { "x-selected": "boolean" } },
          ],
          postInit: [
            { type: "message", text: "string", when: 'eq(options.value, "false")' },
            { type: "message", text: "boolean", when: "eq(options.value, false)" },
          ],
        },
        root,
      );
      const loader = plugin.configTranslators?.get("lando4");
      if (loader === undefined) throw new Error("Missing test encoder");
      const prepared = await Effect.runPromise(
        prepareRecipeInit({
          compiled,
          appRoot: join(root, "app"),
          appName: "test",
          answers: { value },
          encoder: await loader(),
        }),
      );
      if (prepared.status !== "ready") throw new Error("Unexpected missing answers");
      const selected = typeof value === "string" ? "string" : "boolean";
      expect(prepared.preview.landofile).toContain(`selected: ${selected}`);
      expect(
        prepared.actions.map(({ value: action }) => (action.type === "message" ? action.text : action.type)),
      ).toEqual([selected]);
      const lines: string[] = [];
      await runPostInit({
        runBun: async () => {
          throw new TypeError("Unexpected Bun action");
        },
        actions: prepared.actions.map(({ value: action }) => action),
        destination: prepared.appRoot,
        recipeId: compiled.manifest.id,
        appName: prepared.appName,
        answers: prepared.answers,
        io: {
          out: (line) => {
            lines.push(line);
          },
          err: () => {},
        },
      });
      expect(lines).toEqual([selected]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

for (const transport of ["default", "supplied"] as const) {
  test.each(["--global", "  --cwd=/outside", "", "   ", "react-app"])(
    `preflights a ${transport} create-template answer %j before publication`,
    async (value) => {
      const root = await mkdtemp(join(tmpdir(), "prepared-create-answer-"));
      try {
        const recipe = join(root, "create-preflight");
        await mkdir(recipe);
        await Bun.write(
          join(recipe, "recipe.yml"),
          `id: create-preflight
title: Create preflight
description: Effective operand validation
version: 1.0.0
options:
  tpl:
    type:
      kind: string
    default: ${JSON.stringify(transport === "default" ? value : "react-app")}
config:
  runtime: 4
postInit:
  - type: bun
    verb: create
    template: \${answers.tpl}
`,
        );
        const preparation = prepareInitApp({
          cwd: root,
          recipe,
          name: "example",
          destination: join(root, "output"),
          userDataRoot: join(root, "state"),
          full: false,
          nonInteractive: true,
          privateFileAccess: ownerOnlyFileAccess,
          answers: transport === "supplied" ? { tpl: value } : {},
        });
        if (value === "react-app") {
          expect((await preparation).prepared.status).toBe("ready");
        } else {
          await expect(preparation).rejects.toMatchObject({
            _tag: "RecipeInitBlockedError",
            stage: "validate",
          });
        }
        expect(await readdir(root)).toEqual(["create-preflight"]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}
