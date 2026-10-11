import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";
import { nodeWebSnapshotBuilders } from "../node-web-snapshot.ts";
import { cond, encodedStringNode, lit, obj, toolNode } from "../snapshot-expression.ts";
import { recipeSnapshotYaml } from "../snapshot-yaml.ts";
import { NEXTJS_SCAFFOLD_COMMAND } from "./scaffold-command.ts";

export const NEXTJS_RECIPE_VERSION = "0.1.0";
export const NEXTJS_CONTENT_DIGEST =
  "sha256:7c5f2ae9767abdb59d083f3fd4f89270bc615442f969c10279c363ae72d730f9";
export const nextjsProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-nextjs",
  recipeId: "nextjs",
  manifestVersion: NEXTJS_RECIPE_VERSION,
  contentDigest: NEXTJS_CONTENT_DIGEST,
};
export const nextjsDefaults = { node: "lts", database: "postgres", auth: "none" } as const;
const { databaseEnabled, web } = nodeWebSnapshotBuilders({
  port: 3000,
  env: [["NEXTAUTH_PROVIDER", "{{ recipe.auth }}"]],
});
export const nextjsSnapshot: RecipeSnapshot = {
  identity: nextjsProducer,
  optionTypes: {
    node: { kind: "enum", values: ["lts", "22"] },
    database: { kind: "enum", values: ["none", "postgres", "mariadb"] },
    auth: { kind: "enum", values: ["none", "nextauth", "clerk"] },
  },
  defaults: nextjsDefaults,
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
          ["next", toolNode("web", "Run the Next.js CLI inside the web service.", "npx next")],
          ["npm", toolNode("web", "Run npm inside the web service.", "npm")],
          [
            "nextjs-scaffold",
            obj([
              ["service", lit("web")],
              [
                "description",
                lit("Scaffold a Next.js app and install dependencies in the mounted app root."),
              ],
              ["arguments", lit(false)],
              ["cmd", encodedStringNode(NEXTJS_SCAFFOLD_COMMAND)],
            ]),
          ],
        ]),
      ],
    ]),
  },
  assets: [],
};
export const nextjsSnapshotYaml = recipeSnapshotYaml(nextjsSnapshot);
