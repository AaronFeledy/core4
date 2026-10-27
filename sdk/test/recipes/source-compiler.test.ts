import { expect, test } from "bun:test";
import { evaluateTemplateEither } from "@lando/sdk/expressions";
import { encodeLandofileSourceValue, override, reset } from "@lando/sdk/landofile";
import { compileRecipeSource, renderCompiledRecipeSnapshot, renderRecipeSnapshot } from "@lando/sdk/recipes";
import { AbsolutePath, type RecipeConfigLayer, RecipeSnapshot, RecipeSource } from "@lando/sdk/schema";
import { Result, Schema } from "effect";

const context = { sourceKind: "local", packageName: "example", assets: [] } as const;
const base = { id: "example", title: "Example", description: "Example", version: "1.0.0", config: {} };
const renderContext = { appRoot: AbsolutePath.make("/app"), env: {} };

test("compiles an ordinary handwritten service without author AST or digest", () => {
  // Given
  const source = Schema.decodeUnknownSync(RecipeSource)({
    ...base,
    options: {
      php: { type: { kind: "string" }, default: "8.3" },
    },
    config: { services: { appserver: { type: "php:{{ recipe.php }}", webroot: "web" } } },
  });
  // When
  const manifest = Result.getOrThrow(compileRecipeSource(source, context));
  const compiled = Result.getOrThrow(renderCompiledRecipeSnapshot(manifest.snapshot, {}, renderContext));
  const output = Result.getOrThrow(
    evaluateTemplateEither(compiled.pendingSites[0]?.template ?? { whole: false, segments: [] }, {
      recipe: manifest.snapshot.defaults,
    }),
  );
  // Then
  expect(output).toBe("php:8.3");
  expect(compiled.pendingSites.map((site) => site.path)).toEqual([["services", "appserver", "type"]]);
  expect(manifest.snapshot.identity).toMatchObject({
    sourceKind: "local",
    packageName: "example",
    recipeId: "example",
    manifestVersion: "1.0.0",
  });
  expect(Schema.is(RecipeSnapshot)(manifest.snapshot)).toBe(true);
});

test.each([false, true])("applies ordered variants when enabled is %s", (enabled) => {
  // Given
  const source = {
    ...base,
    options: { enabled: { type: { kind: "boolean" }, default: false } },
    config: { services: { app: { type: "nginx", webroot: "base" } } },
    variants: [
      { when: "options.enabled", config: { services: { app: { webroot: "first" } } } },
      { when: "{{ eq(options.enabled, true) }}", config: { services: { app: { webroot: "last" } } } },
    ],
  };
  // When
  const manifest = Result.getOrThrow(compileRecipeSource(source, context));
  const output = Result.getOrThrow(renderRecipeSnapshot(manifest.snapshot, { enabled }));
  // Then
  expect(output).toEqual({ services: { app: { type: "nginx", webroot: enabled ? "last" : "base" } } });
});

test("orders inherited base and variants before child base and variants", () => {
  // Given
  const layers: readonly RecipeConfigLayer[] = [
    { config: { services: { app: { type: "nginx", webroot: "parent" } }, "x-parent": true } },
    { when: "options.enabled", config: { services: { app: { webroot: "parent-variant" } } } },
    { config: { services: { app: { webroot: "child" } } } },
    { when: "options.enabled", config: { "x-child": true } },
  ];
  const source = { ...base, options: { enabled: { type: { kind: "boolean" }, default: true } } };
  // When
  const manifest = Result.getOrThrow(compileRecipeSource(source, { ...context, configLayers: layers }));
  const output = Result.getOrThrow(renderRecipeSnapshot(manifest.snapshot, {}));
  // Then
  expect(output).toEqual({
    services: { app: { type: "nginx", webroot: "child" } },
    "x-parent": true,
    "x-child": true,
  });
});

test("consumes reset and override before emitting authored expression literals", () => {
  // Given
  const child = encodeLandofileSourceValue({
    services: { db: reset(), app: override({ type: "nginx", webroot: "{{ recipe.root }}" }) },
  });
  const source = { ...base, options: { root: { type: { kind: "string" }, default: "web" } } };
  // When
  const manifest = Result.getOrThrow(
    compileRecipeSource(source, {
      ...context,
      configLayers: [
        {
          config: {
            services: {
              db: { type: "mysql" },
              app: { type: "php", webroot: "old", environment: { OLD: "yes" } },
            },
          },
        },
        { config: Schema.decodeUnknownSync(RecipeSource)({ ...base, config: child }).config },
      ],
    }),
  );
  const compiled = Result.getOrThrow(renderCompiledRecipeSnapshot(manifest.snapshot, {}, renderContext));
  // Then
  expect(compiled.document).toEqual({ services: { app: { type: "nginx", webroot: "{{ recipe.root }}" } } });
  expect(compiled.pendingSites.map((site) => site.path)).toEqual([["services", "app", "webroot"]]);
});

test.each([
  { config: { services: { app: { unknown: true } } } },
  { config: { typo: true } },
  { config: { "x-value": "{{ load('private') }}" } },
  { config: { "x-value": "{{ recipe.unknown }}" } },
  { config: { "x-value": "{{ recipe.toString }}" } },
  { config: { "x-value": "${secret:DB}" } },
  { variants: [{ when: "env.FLAG", config: {} }] },
  { variants: [{ when: "options.unknown", config: {} }] },
  { variants: [{ when: "options.toString", config: {} }] },
  { variants: [{ when: "{{ map([], 'load') }}", config: {} }] },
])("rejects malformed config or forbidden dependencies even on dead branches %#", (extra) => {
  // Given / When
  const result = compileRecipeSource({ ...base, ...extra }, context);
  // Then
  expect(Result.isFailure(result)).toBe(true);
});

test("returns the exact variant budget diagnostic before exponential expansion", () => {
  // Given
  const source = {
    ...base,
    options: { enabled: { type: { kind: "boolean" } } },
    variants: Array.from({ length: 9 }, () => ({ when: "options.enabled", config: {} })),
  };
  // When
  const result = compileRecipeSource(source, context);
  // Then
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "RecipeSourceCompileError", reason: "variant-budget", path: "variants" },
  });
});

test("keeps option and helper-produced secret-like text literal after one evaluation", () => {
  // Given
  const text = "${secret:DB} {{ app.name }}";
  const manifest = Result.getOrThrow(
    compileRecipeSource(
      {
        ...base,
        options: {
          text: { type: { kind: "string" }, default: text },
        },
        config: { "x-value": "{{ recipe.text }}", "x-helper": "{{ b64decode('JHtzZWNyZXQ6REJ9') }}" },
      },
      context,
    ),
  );
  // When
  const compiled = Result.getOrThrow(renderCompiledRecipeSnapshot(manifest.snapshot, {}, renderContext));
  const values = compiled.pendingSites.map((site) =>
    Result.getOrThrow(evaluateTemplateEither(site.template, { recipe: manifest.snapshot.defaults })),
  );
  // Then
  expect(values).toEqual([text, "${secret:DB}"]);
});

test("derives stable identity from effective inputs and ordered parent content evidence", () => {
  // Given
  const source = { ...base, config: { services: { app: { type: "nginx", webroot: "web" } } } };
  const parent = {
    sourceKind: "bundled",
    packageName: "recipes",
    recipeId: "parent",
    manifestVersion: "1.0.0",
    contentDigest: `sha256:${"a".repeat(64)}`,
  } as const;
  // When
  const first = Result.getOrThrow(
    compileRecipeSource({ ...source, extends: "/host-one/parent" }, { ...context, parents: [parent] }),
  );
  const relocated = Result.getOrThrow(
    compileRecipeSource(
      {
        ...source,
        extends: "/host-two/parent",
        config: { services: { app: { webroot: "web", type: "nginx" } } },
      },
      { ...context, parents: [parent] },
    ),
  );
  const changed = Result.getOrThrow(
    compileRecipeSource(source, {
      ...context,
      parents: [{ ...parent, contentDigest: `sha256:${"b".repeat(64)}` }],
    }),
  );
  // Then
  expect(first.snapshot.identity).toEqual(relocated.snapshot.identity);
  expect(first.snapshot.identity.contentDigest).not.toBe(changed.snapshot.identity.contentDigest);
});

test("includes observed raw assets in derived identity without asking authors for digests", () => {
  // Given
  const source = { ...base, files: [{ src: "logo.bin", dest: "logo.bin", mode: "0755", template: false }] };
  // When
  const first = Result.getOrThrow(
    compileRecipeSource(source, {
      ...context,
      assets: [{ dest: "logo.bin", digest: `sha256:${"a".repeat(64)}` }],
    }),
  );
  const second = Result.getOrThrow(
    compileRecipeSource(source, {
      ...context,
      assets: [{ dest: "logo.bin", digest: `sha256:${"b".repeat(64)}` }],
    }),
  );
  // Then
  expect(first.snapshot.assets).toEqual([
    { dest: "logo.bin", digest: `sha256:${"a".repeat(64)}`, mode: "0755", template: false },
  ]);
  expect(first.snapshot.identity.contentDigest).not.toBe(second.snapshot.identity.contentDigest);
});

test("renders the maximum permitted variant expansion", () => {
  // Given
  const source = {
    ...base,
    options: { enabled: { type: { kind: "boolean" }, default: false } },
    variants: Array.from({ length: 8 }, () => ({ when: "options.enabled", config: { "x-enabled": true } })),
  };
  // When
  const manifest = Result.getOrThrow(compileRecipeSource(source, context));
  const result = renderRecipeSnapshot(manifest.snapshot, { enabled: true });
  // Then
  expect(Result.getOrThrow(result)).toEqual({ "x-enabled": true });
});

test("omits author file drops from compiled runtime metadata", () => {
  // Given
  const source = { ...base, files: [{ dest: "parent.bin", drop: true }] };
  // When
  const result = compileRecipeSource(source, context);
  // Then
  expect(Result.getOrThrow(result).files).toEqual([]);
});

test("treats condition helper arguments as data rather than authored binding sites", () => {
  // Given
  const source = {
    ...base,
    options: { text: { type: { kind: "string" }, default: "${secret:DB}" } },
    variants: [{ when: "eq(options.text, '${secret:DB}')", config: { "x-matched": true } }],
  };
  const manifest = Result.getOrThrow(compileRecipeSource(source, context));
  // When
  const result = renderCompiledRecipeSnapshot(manifest.snapshot, {}, renderContext);
  // Then
  expect(Result.getOrThrow(result).document).toEqual({ "x-matched": true });
});
