import { expect, test } from "bun:test";
import { plugin } from "@lando/lando4";
import type { RecipeDecomposeInput } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { previewRecipeLandofile } from "../../src/recipes/init-pipeline.ts";
import { isolatedInitDecomposer, isolatedInitManifest } from "./fixtures/isolated-init-recipe/index.ts";

test.each([
  ["distinct destinations", "database.password", "cache.password"],
  ["duplicate destinations", "database.password", "database.password"],
  ["destination matching another prompt", "cacheToken", "database.password"],
] as const)("preserves both prompt references with %s", async (_scenario, databaseField, cacheField) => {
  // Given two distinct prompt names, opaque references, and independently declared destinations.
  const loader = plugin.configTranslators?.get("lando4");
  if (loader === undefined) throw new Error("Missing lando4 encoder");
  const received: RecipeDecomposeInput["secrets"][] = [];

  // When the real translation and encoding pipeline invokes the recipe's decomposer.
  const preview = await Effect.runPromise(
    previewRecipeLandofile({
      manifest: {
        ...isolatedInitManifest,
        prompts: [
          {
            name: "databaseToken",
            type: "secret",
            message: "Database token",
            disposition: { kind: "secret-store", field: databaseField },
          },
          {
            name: "cacheToken",
            type: "secret",
            message: "Cache token",
            disposition: { kind: "secret-store", field: cacheField },
          },
        ],
        postInit: [],
      },
      answers: { php: "8.3", webroot: "web" },
      secretAnswers: {
        databaseToken: "${secret:team/database}",
        cacheToken: "${secret:team/cache}",
      },
      appName: "secret-contract",
      encoder: await loader(),
      decomposer: (ports) => {
        const base = isolatedInitDecomposer(ports);
        return {
          ...base,
          decompose: (input) => {
            received.push(input.secrets);
            return Effect.map(base.decompose(input), (output) => ({
              ...output,
              fragment: {
                ...Schema.decodeUnknownSync(Schema.Record({ key: Schema.String, value: Schema.Unknown }))(
                  output.fragment,
                ),
                "x-decomposer-destinations": Object.fromEntries(
                  Object.entries(input.secrets).map(([prompt, secret]) => [
                    prompt === "databaseToken" ? "database" : "cache",
                    secret.disposition === "secret-store" ? secret.reference : "unexpected-sink",
                  ]),
                ),
              },
            }));
          },
        };
      },
    }),
  );

  // Then neither duplicate fields nor field/prompt collisions drop or rename an entry.
  expect(received).toEqual([
    {
      databaseToken: { disposition: "secret-store", reference: "${secret:team/database}" },
      cacheToken: { disposition: "secret-store", reference: "${secret:team/cache}" },
    },
  ]);
  expect(Bun.YAML.parse(preview.text)).toMatchObject({
    "x-decomposer-destinations": {
      database: "${secret:team/database}",
      cache: "${secret:team/cache}",
    },
  });
});
