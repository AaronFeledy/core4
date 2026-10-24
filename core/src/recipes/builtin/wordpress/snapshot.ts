import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";
import { PHP_DEFAULT, PHP_VERSIONS } from "../php-stack.ts";
import { arr, cond, defaultRoute, lit, obj, toolNode } from "../snapshot-expression.ts";
import { recipeSnapshotYaml } from "../snapshot-yaml.ts";

export const WORDPRESS_RECIPE_VERSION = "0.1.0";
export const WORDPRESS_CONTENT_DIGEST =
  "sha256:120d0083255dae0e0e22165421746841a17d60f7908400137c516cb1ac0f5cc1";
export const wordpressProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-wordpress",
  recipeId: "wordpress",
  manifestVersion: WORDPRESS_RECIPE_VERSION,
  contentDigest: WORDPRESS_CONTENT_DIGEST,
};
const services = (redis: boolean) =>
  obj([
    [
      "appserver",
      obj([
        ["type", lit("php:{{ recipe.php }}")],
        ["primary", lit(true)],
        ["framework", lit("wordpress")],
        ["port", lit(80)],
        ["dependsOn", arr(lit("database"), ...(redis ? [lit("cache")] : []))],
        ["routes", arr(defaultRoute())],
      ]),
    ],
    ["database", obj([["type", lit("mariadb")]])],
    ...(redis ? [["cache", obj([["type", lit("redis")]])] as const] : []),
  ]);
export const wordpressSnapshot: RecipeSnapshot = {
  identity: wordpressProducer,
  optionTypes: {
    php: { kind: "enum", values: [...PHP_VERSIONS] },
    redis: { kind: "boolean" },
  },
  defaults: { php: PHP_DEFAULT, redis: false },
  template: {
    expression: obj([
      ["runtime", lit(4)],
      [
        "services",
        cond(
          { kind: "Path", head: "options", segments: [{ type: "prop", name: "redis" }] },
          services(true),
          services(false),
        ),
      ],
      [
        "tooling",
        obj([
          ["wp", toolNode("appserver", "Run WP-CLI inside the appserver service.", "wp")],
          ["composer", toolNode("appserver", "Run Composer inside the appserver service.", "composer")],
        ]),
      ],
    ]),
  },
  assets: [],
};
export const wordpressSnapshotYaml = recipeSnapshotYaml(wordpressSnapshot);
