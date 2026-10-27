import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plugin } from "@lando/lando4";
import { Effect } from "effect";
import { runPostInit } from "../../src/recipes/post-init/runtime.ts";
import { prepareRecipeInit } from "../../src/recipes/prepared-init.ts";
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
