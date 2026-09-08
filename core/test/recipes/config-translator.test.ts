import { describe, expect, test } from "bun:test";
import { ConfigTranslateError, RecipeDecomposeError } from "@lando/sdk/errors";
import { validateConfigTranslateResult } from "@lando/sdk/landofile";
import { ConfigTranslateDetectInput, ConfigTranslateInput, RecipeProducer } from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";
import type { RecipeDecomposerFactory, RecipeDecomposerShape } from "@lando/sdk/services";
import { Effect, Either, Schema } from "effect";
import { makeRecipeConfigTranslator } from "../../src/recipes/config-translator.ts";
import { makeRecipeTranslatorModule } from "../../src/recipes/translator-module.ts";

const producer = Schema.decodeUnknownSync(RecipeProducer)({
  sourceKind: "bundled",
  packageName: "@lando/recipe",
  recipeId: "example",
  manifestVersion: "1.0.0",
  contentDigest: `sha256:${"0".repeat(64)}`,
});
const redactor = createRedactor("secrets");
const fragment = { name: "example-app", runtime: 4 } as const;
const decompose: RecipeDecomposerShape["decompose"] = (input) =>
  Effect.succeed({
    fragment,
    provenance: {
      id: producer.recipeId,
      version: producer.manifestVersion,
      producer,
      options: input.options,
    },
  });
const factory: RecipeDecomposerFactory = () => ({ producer, decompose });
const ports = { decomposers: new Map([["example", factory]]), redactor };
const request = (id = "example", version = "1.0.0") =>
  Schema.decodeUnknownSync(ConfigTranslateInput)({
    _tag: "recipe-request",
    recipe: { id, version },
    sourceId: "recipe:example:init",
    answers: { name: "option-value-must-not-leak" },
    secretAnswers: { password: { disposition: "secret-store", reference: "vault:example" } },
  });

describe("recipe config translator", () => {
  test("never detects an app when source documents are present", async () => {
    const input = Schema.decodeUnknownSync(ConfigTranslateDetectInput)({
      documents: [
        {
          sourceId: "canonical",
          layerId: "canonical",
          mediaType: "application/yaml",
          contentDigest: `sha256:${"0".repeat(64)}`,
          bytes: "bmFtZTogZXhhbXBsZQ==",
        },
      ],
    });
    const result = await Effect.runPromise(makeRecipeConfigTranslator(ports).detect(input));
    expect(result).toEqual([]);
  });

  test("rejects a document set with lando4 remediation", async () => {
    const input = Schema.decodeUnknownSync(ConfigTranslateInput)({
      _tag: "landofile-document-set",
      documents: [],
      mode: "full",
      selectedSourceIds: [],
      currentLowerV4Fragments: [],
      writableLayerIds: ["canonical"],
    });
    const error = await Effect.runPromise(Effect.flip(makeRecipeConfigTranslator(ports).translate(input)));
    expect(error).toBeInstanceOf(ConfigTranslateError);
    expect(error.translator).toBe("recipe");
    expect(error.remediation).toContain("--from lando4");
  });

  test("names unknown recipes and lists known ids", async () => {
    const error = await Effect.runPromise(
      Effect.flip(makeRecipeConfigTranslator(ports).translate(request("missing"))),
    );
    expect(error).toBeInstanceOf(ConfigTranslateError);
    expect(error.message).toContain("missing");
    expect(error.remediation).toContain("example");
  });

  test.each(["identity", "version"])(
    "rejects a producer %s mismatch before decomposition",
    async (mismatch) => {
      let calls = 0;
      const mismatched: RecipeDecomposerFactory = () => ({
        producer: {
          ...producer,
          ...(mismatch === "identity" ? { recipeId: "other" } : { manifestVersion: "2.0.0" }),
        },
        decompose: (input) => {
          calls++;
          return decompose(input);
        },
      });
      const translator = makeRecipeConfigTranslator({
        ...ports,
        decomposers: new Map([["example", mismatched]]),
      });
      const error = await Effect.runPromise(Effect.flip(translator.translate(request())));
      expect(error).toBeInstanceOf(ConfigTranslateError);
      expect(calls).toBe(0);
    },
  );

  test("delegates injected ports and answers and returns one validated canonical output", async () => {
    const input = request();
    const stub: RecipeDecomposerFactory = (injected) => {
      expect(injected.redactor).toBe(redactor);
      return {
        producer,
        decompose: (value) => {
          expect(value).toEqual({
            producer,
            options: { name: "option-value-must-not-leak" },
            secrets: { password: { disposition: "secret-store", reference: "vault:example" } },
          });
          return decompose(value);
        },
      };
    };
    const translator = makeRecipeConfigTranslator({ ...ports, decomposers: new Map([["example", stub]]) });
    const result = await Effect.runPromise(translator.translate(input));
    expect<unknown>(result.outputs).toEqual([
      { targetLayer: "canonical", fragment, sourceIds: ["recipe:example:init"] },
    ]);
    expect(result.deletions).toHaveLength(0);
    expect<unknown>(result.diagnostics).toEqual([
      {
        kind: "generated",
        sourceId: "recipe:example:init",
        keyPath: [],
        message: expect.stringMatching(/example.*1\.0\.0.*canonical/),
      },
    ]);
    expect(Either.isRight(validateConfigTranslateResult(input, result))).toBe(true);
  });

  test("maps decomposition reason and remediation without copying option values", async () => {
    const failing: RecipeDecomposerFactory = () => ({
      producer,
      decompose: () =>
        Effect.fail(
          new RecipeDecomposeError({
            recipeId: "example",
            reason: "option-type",
            message: "Invalid option-value-must-not-leak",
            remediation: "Choose a supported option type.",
          }),
        ),
    });
    const translator = makeRecipeConfigTranslator({ ...ports, decomposers: new Map([["example", failing]]) });
    const error = await Effect.runPromise(Effect.flip(translator.translate(request())));
    expect(error).toBeInstanceOf(ConfigTranslateError);
    expect(error.message).toContain("option-type");
    expect(error.message).toContain("Choose a supported option type.");
    expect(JSON.stringify(error)).not.toContain("option-value-must-not-leak");
  });

  test("fails self-validation when a decomposer returns an invalid authoring fragment", async () => {
    const invalid: RecipeDecomposerFactory = () => ({
      producer,
      decompose: (input) =>
        decompose(input).pipe(
          Effect.map((result) => ({ ...result, fragment: { runtime: "{{ nope.scope }}" } })),
        ),
    });
    const translator = makeRecipeConfigTranslator({ ...ports, decomposers: new Map([["example", invalid]]) });
    const error = await Effect.runPromise(Effect.flip(translator.translate(request())));
    expect(error).toBeInstanceOf(ConfigTranslateError);
  });

  test("declares matching contribution ids and reuses a decode-only translator", async () => {
    const module = makeRecipeTranslatorModule(ports);
    const ids = module.manifest.contributes?.configTranslators?.map(({ id }) => id) ?? [];
    expect(ids).toEqual(["recipe"]);
    expect([...(module.configTranslators?.keys() ?? [])]).toEqual(ids);
    const loader = module.configTranslators?.get("recipe");
    expect(loader).toBeDefined();
    if (loader === undefined) return;
    const translator = await loader();
    expect(translator.id).toBe("recipe");
    expect(translator.inputKinds).toEqual(["recipe-request"]);
    expect(translator.encode).toBeUndefined();
    expect("encode" in translator).toBe(false);
    expect(await loader()).toBe(translator);
  });
});
