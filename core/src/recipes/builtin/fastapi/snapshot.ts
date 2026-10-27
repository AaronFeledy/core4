import type { ExpressionNode } from "@lando/sdk/expressions";
import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";
import { arr, defaultRoute, encodedStringNode, lit, obj, toolNode } from "../snapshot-expression.ts";
import { recipeSnapshotYaml } from "../snapshot-yaml.ts";
import { FASTAPI_ENTRYPOINT, FASTAPI_ENVIRONMENT } from "./startup.ts";

export const FASTAPI_RECIPE_VERSION = "0.1.0";
export const FASTAPI_CONTENT_DIGEST =
  "sha256:1a2d4ad9ff3d77f153d176ba01dfc7c350317042b94983f7370bd1cad270af71";
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
              ["entrypoint", arr(...FASTAPI_ENTRYPOINT.map(encodedStringNode))],
              [
                "environment",
                obj(Object.entries(FASTAPI_ENVIRONMENT).map(([key, value]) => [key, lit(value)])),
              ],
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
