import type { ExpressionNode } from "@lando/sdk/expressions";
import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";
import { arr, defaultRoute, lit, obj, toolNode } from "../snapshot-expression.ts";
import { recipeSnapshotYaml } from "../snapshot-yaml.ts";

export const FASTAPI_RECIPE_VERSION = "0.1.0";
export const FASTAPI_CONTENT_DIGEST =
  "sha256:2e7e0d8da6937c1badc267093a9511b9beaa7f474400ca422009991752f567a7";
export const fastapiProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-fastapi",
  recipeId: "fastapi",
  manifestVersion: FASTAPI_RECIPE_VERSION,
  contentDigest: FASTAPI_CONTENT_DIGEST,
};
export const fastapiDefaults = {} as const;
const serviceOfType = (type: string): ExpressionNode => obj([["type", lit(type)]]);
export const fastapiSnapshot: RecipeSnapshot = {
  identity: fastapiProducer,
  optionTypes: {},
  defaults: fastapiDefaults,
  template: {
    expression: obj([
      ["runtime", lit(4)],
      [
        "services",
        obj([
          [
            "web",
            obj([
              ["type", lit("python:3.12")],
              ["framework", lit("fastapi")],
              ["port", lit(8000)],
              ["dependsOn", arr(lit("database"), lit("cache"))],
              ["routes", arr(defaultRoute())],
            ]),
          ],
          ["database", serviceOfType("postgres")],
          ["cache", serviceOfType("redis")],
        ]),
      ],
      [
        "tooling",
        obj([
          ["uvicorn", toolNode("web", "Run uvicorn inside the web service.", "uvicorn")],
          ["pip", toolNode("web", "Run pip inside the web service.", "pip")],
        ]),
      ],
    ]),
  },
  assets: [],
};
export const fastapiSnapshotYaml = recipeSnapshotYaml(fastapiSnapshot);
