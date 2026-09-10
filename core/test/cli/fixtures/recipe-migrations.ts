import type { ExpressionNode } from "@lando/sdk/expressions";
import { deriveHunkId } from "@lando/sdk/recipes";
import {
  LandofileRecipeProvenance,
  type RecipeMigration,
  type RecipeMigrationHunk,
  type RecipeProducer,
  type RecipeSnapshot,
} from "@lando/sdk/schema";
import { Schema } from "effect";

type HunkDraft = RecipeMigrationHunk extends infer H
  ? H extends RecipeMigrationHunk
    ? Omit<H, "id">
    : never
  : never;

const producer = (version: string, digit: string): RecipeProducer => ({
  sourceKind: "bundled",
  packageName: "@lando/recipe-migrate-demo",
  recipeId: "migrate-demo",
  manifestVersion: version,
  contentDigest: `sha256:${digit.repeat(64)}`,
});
const literal = (value: string | number): ExpressionNode => ({ kind: "Literal", value });
const object = (entries: Readonly<Record<string, ExpressionNode>>): ExpressionNode => ({
  kind: "ObjectLiteral",
  entries: Object.entries(entries).map(([key, value]) => ({ key, value })),
});
const template = (stage: 0 | 1 | 2): RecipeSnapshot["template"] => {
  const database = stage === 2 ? "db" : "database";
  return {
    expression: object({
      runtime: literal(4),
      services: object({
        appserver: object({
          type: literal("php:{{ recipe.php }}"),
          webroot: literal(stage === 2 ? "{{ recipe.webroot }}/public" : "{{ recipe.webroot }}"),
          port: literal(stage === 2 ? 8080 : 80),
          dependsOn: { kind: "ArrayLiteral", elements: [literal(database)] },
          ...(stage === 0
            ? { environment: object({ LEGACY: literal("yes") }) }
            : { environment: object({ FEATURE: literal("enabled") }) }),
        }),
        [database]: object({ type: literal("{{ recipe.database }}") }),
      }),
      tooling: object({
        php: object({
          service: literal("appserver"),
          cmds: { kind: "ArrayLiteral", elements: [literal("php")] },
        }),
        mysql: object({
          service: literal(database),
          cmds: { kind: "ArrayLiteral", elements: [literal("mysql")] },
        }),
      }),
    }),
  };
};
const snapshot = (identity: RecipeProducer, stage: 0 | 1 | 2): RecipeSnapshot => ({
  identity,
  optionTypes: { php: { kind: "string" }, webroot: { kind: "string" }, database: { kind: "string" } },
  defaults: { php: stage === 0 ? "8.2" : "8.3", webroot: "/app", database: "mariadb:11.4" },
  template: template(stage),
  assets: [],
});

export const makeMigrationFixture = () => {
  const v100 = snapshot(producer("1.0.0", "1"), 0);
  const v110 = snapshot(producer("1.1.0", "2"), 1);
  const v120 = snapshot(producer("1.2.0", "3"), 2);
  const edge = (
    fromSnapshot: RecipeSnapshot,
    toSnapshot: RecipeSnapshot,
    drafts: readonly HunkDraft[],
  ): RecipeMigration => ({
    from: fromSnapshot.identity,
    to: toSnapshot.identity,
    fromSnapshot,
    toSnapshot,
    hunks: drafts.map((hunk) => ({
      ...hunk,
      id: deriveHunkId({
        producer: v120.identity,
        from: fromSnapshot.identity,
        to: toSnapshot.identity,
        layer: hunk.layer,
        kind: hunk.kind,
        path: hunk.path,
      }),
    })),
  });
  const first = edge(v100, v110, [
    { kind: "option-default", layer: "canonical", path: "recipe.options.php", old: "8.2", new: "8.3" },
    { kind: "add", layer: "canonical", path: "services.appserver.environment.FEATURE", new: "enabled" },
    { kind: "remove", layer: "canonical", path: "services.appserver.environment.LEGACY", old: "yes" },
  ]);
  const second = edge(snapshot(producer("1.1.0", "2"), 1), v120, [
    { kind: "replace", layer: "canonical", path: "services.appserver.port", old: 80, new: 8080 },
    {
      kind: "rename",
      layer: "canonical",
      path: "services.database",
      old: "services.database",
      new: "services.db",
    },
    {
      kind: "replace",
      layer: "canonical",
      path: "services.appserver.webroot",
      old: "{{ recipe.webroot }}",
      new: "{{ recipe.webroot }}/public",
    },
  ]);
  const migrations = [first, second] as const;
  const nonCanonical = edge(
    v100,
    v110,
    first.hunks.map((hunk) =>
      hunk.path === "services.appserver.environment.FEATURE" ? { ...hunk, layer: "local" } : hunk,
    ),
  );
  const unrenderable: RecipeSnapshot = {
    ...v120,
    template: {
      expression: {
        kind: "Call",
        callee: "fromJson",
        args: [{ kind: "Path", head: "options", segments: [{ type: "prop", name: "webroot" }] }],
      },
    },
  };
  return {
    target: v120,
    snapshots: [v100, v110, v120] as const,
    migrations,
    nonCanonical: [nonCanonical, second] as const,
    renderFailure: {
      target: unrenderable,
      migrations: [first, { ...second, toSnapshot: unrenderable }] as const,
    },
    malformed: {
      "snapshot-mismatch": [{ ...first, fromSnapshot: v110 }, second] as const,
      "identity-drift": [
        first,
        { ...second, fromSnapshot: { ...v110, defaults: { ...v110.defaults, php: "8.4" } } },
      ] as const,
    },
  };
};

const landofile = (
  input: { readonly php?: string; readonly webroot?: string; readonly appserver?: string } = {},
): string => {
  const appserver = input.appserver ?? "appserver";
  return `name: migrate-demo
runtime: 4
recipe:
  id: migrate-demo
  version: 1.0.0
  producer:
    sourceKind: bundled
    packageName: "@lando/recipe-migrate-demo"
    recipeId: migrate-demo
    manifestVersion: 1.0.0
    contentDigest: ${producer("1.0.0", "1").contentDigest}
  options:
    php: "${input.php ?? "8.2"}"
    webroot: /app
    database: mariadb:11.4
${appserver === "appserver" ? "" : `  services:\n    appserver: ${appserver}\n`}services:
  ${appserver}:
    type: "php:{{ recipe.php }}"
    webroot: "${input.webroot ?? "{{ recipe.webroot }}"}"
    port: 80
    dependsOn:
      - database
    environment:
      LEGACY: "yes"
  database:
    type: "{{ recipe.database }}"
tooling:
  php:
    service: ${appserver}
    cmds:
      - php
  mysql:
    service: database
    cmds:
      - mysql
`;
};

export const managedLandofile = (): string => landofile();
export const takenOverLandofile = (): string => landofile({ webroot: "/custom" });
export const customizedOptionLandofile = (): string => landofile({ php: "8.4" });
export const renamedServiceLandofile = (): string => landofile({ appserver: "web" });
export const parseMigrationLandofile = (text: string) => {
  const document = Schema.decodeUnknownSync(Schema.Record({ key: Schema.String, value: Schema.Unknown }))(
    Bun.YAML.parse(text),
  );
  const provenance = Schema.decodeUnknownSync(LandofileRecipeProvenance)(document.recipe);
  return { document, provenance };
};

export const conflictingSecondEdgeFixture = () => ({
  ...makeMigrationFixture(),
  ...parseMigrationLandofile(managedLandofile().replace("port: 80", "port: 9000")),
});
export const renameCollisionFixture = () => ({
  ...makeMigrationFixture(),
  ...parseMigrationLandofile(
    managedLandofile().replace("  database:\n", "  db:\n    type: redis:7\n  database:\n"),
  ),
});
