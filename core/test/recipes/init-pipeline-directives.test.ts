import { expect, test } from "bun:test";
import { plugin } from "@lando/lando4";
import { isPlainRecord } from "@lando/sdk/landofile";
import { Effect } from "effect";
import { previewRecipeLandofile } from "../../src/recipes/init-pipeline.ts";
import { isolatedInitDecomposer, isolatedInitManifest } from "./fixtures/isolated-init-recipe/index.ts";

test("recipe preview consumes wire resets before encoding its effective context", async () => {
  const loader = plugin.configTranslators?.get("lando4");
  if (loader === undefined) throw new Error("Missing encoder");
  const result = await Effect.runPromise(
    previewRecipeLandofile({
      manifest: isolatedInitManifest,
      decomposer: (ports) => {
        const base = isolatedInitDecomposer(ports);
        return {
          ...base,
          decompose: (input) =>
            Effect.map(base.decompose(input), (result) => {
              if (!isPlainRecord(result.fragment)) throw new Error("Expected fixture mapping");
              return {
                ...result,
                fragment: {
                  ...result.fragment,
                  services: { web: { image: "nginx", environment: { OLD: { _tag: "LandofileReset" } } } },
                },
              };
            }),
        };
      },
      answers: { php: "8.3", webroot: "web" },
      appName: "directive-preview",
      encoder: await loader(),
    }),
  );
  expect(result.text).toContain("name: directive-preview");
  expect(result.text).not.toContain("LandofileReset");
  expect(result.text).not.toContain("OLD");
});
