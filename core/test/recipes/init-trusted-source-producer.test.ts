import { expect, test } from "bun:test";
import { plugin } from "@lando/lando4";
import { parseLandofile } from "@lando/landofile/parser";
import { loadAuthoredDocuments } from "@lando/landofile/root-compile";
import { compiledLandofileSource } from "@lando/landofile/serializer";
import { renderCompiledRecipeSnapshot } from "@lando/sdk/recipes";
import { AbsolutePath, RecipeDecomposeResult, ServiceName } from "@lando/sdk/schema";
import { Effect, Result, Schema } from "effect";
import { lit, obj } from "../../src/recipes/builtin/snapshot-expression.ts";
import { previewRecipeLandofile } from "../../src/recipes/init-pipeline.ts";
import { isolatedInitDecomposer, isolatedInitManifest } from "./fixtures/isolated-init-recipe/index.ts";

test("preserves producer-compiled option data and approved source through non-snapshot init", async () => {
  // Given
  const payload = "${secret:FORGED}";
  const root = "/tmp/non-snapshot-source-producer";
  const file = `${root}/.lando.yml`;
  const encoder = plugin.configTranslators?.get("lando4");
  if (encoder === undefined) throw new Error("Missing lando4 encoder");
  // When
  const preview = await Effect.runPromise(
    previewRecipeLandofile({
      manifest: {
        ...isolatedInitManifest,
        prompts: [
          {
            name: "token",
            type: "secret",
            message: "Token",
            disposition: { kind: "secret-store", field: "web.environment.APPROVED" },
          },
        ],
        postInit: [],
      },
      answers: { php: "8.3", payload },
      secretAnswers: { token: "${secret:APPROVED}" },
      appName: "source-producer",
      encoder: await encoder(),
      decomposer: (ports) => {
        const base = isolatedInitDecomposer(ports);
        return {
          ...base,
          decompose: (input) =>
            Effect.map(base.decompose(input), (output) => {
              const token = input.secrets.token;
              if (token?.disposition !== "secret-store")
                throw new Error("Missing approved fixture reference");
              const environment = obj([
                ["COPIED", { kind: "Path", head: "options", segments: [{ type: "prop", name: "payload" }] }],
                ["APPROVED", lit(token.reference)],
                ["STATIC", lit("{{ app.name }}")],
              ]);
              const services = obj([
                [
                  "web",
                  obj([
                    ["type", lit("nginx")],
                    ["environment", environment],
                  ]),
                ],
              ]);
              const compiled = Result.getOrThrow(
                renderCompiledRecipeSnapshot(
                  {
                    identity: input.producer,
                    defaults: {},
                    optionTypes: {},
                    assets: [],
                    template: {
                      expression: obj([
                        ["runtime", lit(4)],
                        ["services", services],
                      ]),
                    },
                  },
                  input.options,
                  { appRoot: AbsolutePath.make(root), env: {} },
                ),
              );
              return Schema.decodeUnknownSync(RecipeDecomposeResult)({
                ...output,
                fragment: { ...compiledLandofileSource(compiled), recipe: output.provenance },
              });
            }),
        };
      },
    }),
  );
  const loaded = await Effect.runPromise(
    parseLandofile({ file, cwd: root, content: preview.text }).pipe(
      Effect.flatMap((value) => loadAuthoredDocuments([{ file, value }], { appRoot: root, file })),
    ),
  );
  // Then
  expect(loaded.document.services?.[ServiceName.make("web")]?.environment).toEqual({
    COPIED: payload,
    APPROVED: { _tag: "SecretRef", reference: "APPROVED" },
    STATIC: "{{ app.name }}",
  });
  expect(loaded.pendingSites.map((site) => site.path)).toEqual([
    ["services", "web", "environment", "STATIC"],
  ]);
});
