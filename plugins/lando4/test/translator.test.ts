import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { validateConfigTranslateResult } from "@lando/sdk/landofile";
import { ConfigTranslateSourceId } from "@lando/sdk/schema";
import type { ConfigTranslateInput, ConfigTranslateResult } from "@lando/sdk/schema";

import { lando4ConfigTranslator } from "../src/translator.ts";

import { CANONICAL, LEGACY, LOCAL, canonicalOnly, makeInput } from "./lando4-translator-fixtures.ts";

const translate = (input: ConfigTranslateInput): Promise<ConfigTranslateResult> =>
  Effect.runPromise(lando4ConfigTranslator.translate(input));

describe("lando4 translator identity", () => {
  test("emits one authoring fragment per writable v4 layer with no diagnostics", async () => {
    const result = await translate(makeInput({ documents: canonicalOnly }));
    expect(result.diagnostics).toEqual([]);
    expect(result.deletions).toEqual([]);
    expect(result.outputs).toHaveLength(1);
    const [output] = result.outputs;
    expect(output?.targetLayer).toBe("canonical");
    expect(output?.sourceIds).toEqual([ConfigTranslateSourceId.make(".lando.yml")]);
    expect<unknown>(output?.fragment).toEqual({
      name: "myapp",
      runtime: 4,
      services: { web: { type: "lando", port: "{{ env.PORT }}" } },
    });
  });

  test("keeps every source layer as its own output", async () => {
    const result = await translate(
      makeInput({
        documents: [...canonicalOnly, { path: ".lando.local.yml", layerId: "local", content: LOCAL }],
      }),
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.outputs.map((output) => output.targetLayer)).toEqual(["canonical", "local"]);
  });

  test("is deterministic across repeated runs", async () => {
    const input = makeInput({ documents: canonicalOnly });
    expect(JSON.stringify(await translate(input))).toBe(JSON.stringify(await translate(input)));
  });
});

describe("lando4 translator omissions", () => {
  test("drops a nonwritable layer with a remediated dropped diagnostic", async () => {
    const result = await translate(
      makeInput({
        documents: [...canonicalOnly, { path: ".lando.local.yml", layerId: "local", content: LOCAL }],
        writable: ["canonical"],
      }),
    );
    expect(result.outputs.map((output) => output.targetLayer)).toEqual(["canonical"]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.kind).toBe("dropped");
    expect(result.diagnostics[0]?.sourceId).toBe(ConfigTranslateSourceId.make(".lando.local.yml"));
    expect(result.diagnostics[0]?.remediation).toContain("local");
  });

  test("reports a TypeScript Landofile as unsupported without executing it", async () => {
    const result = await translate(
      makeInput({
        documents: [
          ...canonicalOnly,
          {
            path: ".lando.local.ts",
            layerId: "local",
            content: "export default { name: 'boom' };\n",
            mediaType: "application/octet-stream",
          },
        ],
      }),
    );
    expect(result.outputs.map((output) => output.targetLayer)).toEqual(["canonical"]);
    expect(result.diagnostics.map(({ kind }) => kind)).toEqual(["unsupported"]);
    expect(result.diagnostics[0]?.message).toContain("never executed");
  });

  test("rejects a document that is not canonical v4 authoring data", async () => {
    const result = await translate(
      makeInput({ documents: [{ path: ".lando.yml", layerId: "canonical", content: LEGACY }] }),
    );
    expect(result.outputs).toEqual([]);
    expect(result.diagnostics.map(({ kind }) => kind)).toEqual(["unsupported"]);
  });

  test("refuses two documents claiming one layer instead of folding them", async () => {
    const result = await translate(
      makeInput({
        documents: [
          { path: ".lando.yml", layerId: "canonical", content: CANONICAL },
          { path: ".lando.yaml", layerId: "canonical", content: CANONICAL },
        ],
      }),
    );
    expect(result.outputs).toEqual([]);
    expect(result.diagnostics.map(({ kind }) => kind)).toEqual(["unsupported", "unsupported"]);
  });

  test("treats nonselected single-layer documents as context, not omitted input", async () => {
    const result = await translate(
      makeInput({
        documents: [...canonicalOnly, { path: ".lando.local.yml", layerId: "local", content: LOCAL }],
        mode: "single-layer",
        selected: [".lando.local.yml"],
      }),
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.outputs.map((output) => output.targetLayer)).toEqual(["local"]);
  });

  test("orders mixed dropped and unsupported diagnostics by source", async () => {
    const input = makeInput({
      documents: [...canonicalOnly, { path: ".lando.local.yml", layerId: "local", content: LEGACY }],
      writable: ["local"],
    });
    const result = await translate(input);
    expect(result.diagnostics.map(({ kind, sourceId }) => [kind, String(sourceId)])).toEqual([
      ["dropped", ".lando.yml"],
      ["unsupported", ".lando.local.yml"],
    ]);
    expect(validateConfigTranslateResult(input, result)._tag).toBe("Right");
  });

  test("fails a recipe request rather than inventing recipe output", async () => {
    const exit = await Effect.runPromiseExit(
      lando4ConfigTranslator.translate({
        _tag: "recipe-request",
        recipe: { id: "lamp", version: "1.0.0" },
        sourceId: ConfigTranslateSourceId.make("recipe:lamp"),
        answers: {},
        secretAnswers: {},
      }),
    );
    expect(exit._tag).toBe("Failure");
  });
});
