import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";
import { nodeWebSnapshotBuilders } from "../node-web-snapshot.ts";
import { cond, lit, obj, toolNode } from "../snapshot-expression.ts";
import { recipeSnapshotYaml } from "../snapshot-yaml.ts";

export const SVELTEKIT_RECIPE_VERSION = "0.1.0";
export const SVELTEKIT_CONTENT_DIGEST =
  "sha256:f8a23c071d0f1b1528573a6514c9927ab5f2a64a286be3d5a7e58f9c5bfec469";
export const sveltekitProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-sveltekit",
  recipeId: "sveltekit",
  manifestVersion: SVELTEKIT_RECIPE_VERSION,
  contentDigest: SVELTEKIT_CONTENT_DIGEST,
};
export const sveltekitDefaults = { node: "lts", adapter: "node", database: "none" } as const;
const { databaseEnabled, web } = nodeWebSnapshotBuilders({
  port: 5173,
  env: [["SVELTEKIT_ADAPTER", "{{ recipe.adapter }}"]],
});
export const sveltekitSnapshot: RecipeSnapshot = {
  identity: sveltekitProducer,
  optionTypes: {
    node: { kind: "enum", values: ["lts", "22"] },
    adapter: { kind: "enum", values: ["node", "auto"] },
    database: { kind: "enum", values: ["none", "postgres", "mariadb"] },
  },
  defaults: sveltekitDefaults,
  template: {
    expression: obj([
      ["runtime", lit(4)],
      [
        "services",
        cond(
          databaseEnabled(),
          obj([
            ["web", web()],
            ["database", obj([["type", lit("{{ recipe.database }}")]])],
          ]),
          obj([["web", web()]]),
        ),
      ],
      [
        "tooling",
        obj([
          ["svelte", toolNode("web", "Run the Svelte CLI inside the web service.", "npx svelte-kit")],
          ["npm", toolNode("web", "Run npm inside the web service.", "npm")],
        ]),
      ],
    ]),
  },
  assets: [],
};
export const sveltekitSnapshotYaml = recipeSnapshotYaml(sveltekitSnapshot);
