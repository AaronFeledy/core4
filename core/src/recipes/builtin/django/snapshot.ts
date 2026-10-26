import type { ExpressionNode } from "@lando/sdk/expressions";
import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";
import { arr, cond, defaultRoute, lit, obj, toolNode } from "../snapshot-expression.ts";
import { recipeSnapshotYaml } from "../snapshot-yaml.ts";

export const DJANGO_RECIPE_VERSION = "0.1.0";
export const DJANGO_CONTENT_DIGEST =
  "sha256:a38a3b61a2b74402b00ab37c4965c600bbde56629b3ec9a7280410b8c531b3c5";
export const djangoProducer: RecipeProducer = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-django",
  recipeId: "django",
  manifestVersion: DJANGO_RECIPE_VERSION,
  contentDigest: DJANGO_CONTENT_DIGEST,
};
export const djangoDefaults = { celery: false } as const;
const celeryEnabled = (): ExpressionNode => ({
  kind: "Path",
  head: "options",
  segments: [{ type: "prop", name: "celery" }],
});
const backingDependencies = (): ExpressionNode => arr(lit("database"), lit("cache"));
const environment = (): ExpressionNode =>
  obj([
    ["DJANGO_SETTINGS_MODULE", lit("config.settings")],
    [
      "DATABASE_URL",
      lit(
        "postgresql://{{ url.encodeComponent(services.database.creds.user) }}:{{ url.encodeComponent(services.database.creds.password) }}@database:{{ services.database.port }}/{{ url.encodeComponent(services.database.creds.database) }}",
      ),
    ],
    ["REDIS_URL", lit("redis://cache:6379")],
  ]);
const web = (): ExpressionNode =>
  obj([
    ["type", lit("python:3.12")],
    ["framework", lit("django")],
    ["port", lit(8000)],
    ["environment", environment()],
    ["dependsOn", backingDependencies()],
    ["routes", arr(defaultRoute())],
  ]);
const worker = (): ExpressionNode =>
  obj([
    ["type", lit("python:3.12")],
    ["framework", lit("django")],
    ["command", lit("celery -A app worker --loglevel=info")],
    ["restart", lit("unless-stopped")],
    ["environment", environment()],
    ["dependsOn", backingDependencies()],
  ]);
const serviceOfType = (type: string): ExpressionNode => obj([["type", lit(type)]]);
const services = (celery: boolean): ExpressionNode =>
  obj([
    ["web", web()],
    ["database", serviceOfType("postgres")],
    ["cache", serviceOfType("redis")],
    ...(celery ? [["worker", worker()] as const] : []),
  ]);
export const djangoSnapshot: RecipeSnapshot = {
  identity: djangoProducer,
  optionTypes: { celery: { kind: "boolean" } },
  defaults: djangoDefaults,
  template: {
    expression: obj([
      ["runtime", lit(4)],
      ["services", cond(celeryEnabled(), services(true), services(false))],
      [
        "tooling",
        obj([
          [
            "django",
            toolNode("web", "Run the Django management script inside the web service.", "python manage.py"),
          ],
          ["pip", toolNode("web", "Run pip inside the web service.", "pip")],
        ]),
      ],
    ]),
  },
  assets: [],
};
export const djangoSnapshotYaml = recipeSnapshotYaml(djangoSnapshot);
