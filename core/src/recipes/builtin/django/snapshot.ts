import type { ExpressionNode } from "@lando/sdk/expressions";
import type { RecipeProducer, RecipeSnapshot } from "@lando/sdk/schema";

import { recipeSnapshotYaml } from "../snapshot-yaml.ts";

export const DJANGO_RECIPE_VERSION = "0.1.0";
export const DJANGO_CONTENT_DIGEST =
  "sha256:a2e24faf940de5be6cf5d23d3e1e211beb6553e82837513f6c6b2840d69be395";

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

const backingDependencies = (): ExpressionNode => ({
  kind: "ArrayLiteral",
  elements: [
    { kind: "Literal", value: "database" },
    { kind: "Literal", value: "cache" },
  ],
});

const primaryRoutes = (): ExpressionNode => ({
  kind: "ArrayLiteral",
  elements: [
    {
      kind: "ObjectLiteral",
      entries: [
        { key: "hostname", value: { kind: "Literal", value: "{{ app.name }}.{{ proxy.defaultDomain }}" } },
        { key: "scheme", value: { kind: "Literal", value: "both" } },
      ],
    },
  ],
});

const web = (): ExpressionNode => ({
  kind: "ObjectLiteral",
  entries: [
    { key: "type", value: { kind: "Literal", value: "python:3.12" } },
    { key: "framework", value: { kind: "Literal", value: "django" } },
    { key: "port", value: { kind: "Literal", value: 8000 } },
    { key: "dependsOn", value: backingDependencies() },
    { key: "routes", value: primaryRoutes() },
  ],
});

const worker = (): ExpressionNode => ({
  kind: "ObjectLiteral",
  entries: [
    { key: "type", value: { kind: "Literal", value: "python:3.12" } },
    { key: "framework", value: { kind: "Literal", value: "django" } },
    { key: "command", value: { kind: "Literal", value: "celery -A app worker --loglevel=info" } },
    { key: "dependsOn", value: backingDependencies() },
  ],
});

const serviceOfType = (type: string): ExpressionNode => ({
  kind: "ObjectLiteral",
  entries: [{ key: "type", value: { kind: "Literal", value: type } }],
});

const services = (celery: boolean): ExpressionNode => ({
  kind: "ObjectLiteral",
  entries: [
    { key: "web", value: web() },
    { key: "database", value: serviceOfType("postgres") },
    { key: "cache", value: serviceOfType("redis") },
    ...(celery ? [{ key: "worker", value: worker() }] : []),
  ],
});

const tool = (description: string, command: string): ExpressionNode => ({
  kind: "ObjectLiteral",
  entries: [
    { key: "service", value: { kind: "Literal", value: "web" } },
    { key: "description", value: { kind: "Literal", value: description } },
    { key: "cmds", value: { kind: "ArrayLiteral", elements: [{ kind: "Literal", value: command }] } },
  ],
});

export const djangoSnapshot: RecipeSnapshot = {
  identity: djangoProducer,
  optionTypes: { celery: { kind: "boolean" } },
  defaults: djangoDefaults,
  template: {
    expression: {
      kind: "ObjectLiteral",
      entries: [
        { key: "runtime", value: { kind: "Literal", value: 4 } },
        {
          key: "services",
          value: {
            kind: "Conditional",
            test: celeryEnabled(),
            consequent: services(true),
            alternate: services(false),
          },
        },
        {
          key: "tooling",
          value: {
            kind: "ObjectLiteral",
            entries: [
              {
                key: "django",
                value: tool("Run the Django management script inside the web service.", "python manage.py"),
              },
              { key: "pip", value: tool("Run pip inside the web service.", "pip") },
            ],
          },
        },
      ],
    },
  },
  assets: [],
};

export const djangoSnapshotYaml = recipeSnapshotYaml(djangoSnapshot);
