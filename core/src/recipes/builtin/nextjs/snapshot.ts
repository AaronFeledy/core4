import type { ExpressionNode } from "@lando/sdk/expressions";
import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";
import { arr, call, cond, defaultRoute, lit, obj, toolNode } from "../snapshot-expression.ts";
import { recipeSnapshotYaml } from "../snapshot-yaml.ts";

export const NEXTJS_RECIPE_VERSION = "0.1.0";
export const NEXTJS_CONTENT_DIGEST =
  "sha256:58a8c095d77b22d51563d16f4ea9828b22e6fece178bec6434c0f56594fd23bb";
export const nextjsProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-nextjs",
  recipeId: "nextjs",
  manifestVersion: NEXTJS_RECIPE_VERSION,
  contentDigest: NEXTJS_CONTENT_DIGEST,
};
export const nextjsDefaults = { node: "lts", database: "postgres", auth: "none" } as const;
const databaseEnabled = (): ExpressionNode =>
  call("ne", { kind: "Path", head: "options", segments: [{ type: "prop", name: "database" }] }, lit("none"));
const webService = (hasDatabase: boolean): ExpressionNode =>
  obj([
    ["type", lit("node:{{ recipe.node }}")],
    ["port", lit(3000)],
    ["environment", obj([["NEXTAUTH_PROVIDER", lit("{{ recipe.auth }}")]])],
    ["routes", arr(defaultRoute())],
    ...(hasDatabase ? [["dependsOn", arr(lit("database"))] as const] : []),
  ]);
const web = (): ExpressionNode => cond(databaseEnabled(), webService(true), webService(false));
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
        ]),
      ],
    ]),
  },
  assets: [],
};
export const nextjsSnapshotYaml = recipeSnapshotYaml(nextjsSnapshot);
