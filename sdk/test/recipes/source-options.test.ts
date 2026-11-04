import { expect, test } from "bun:test";
import { compileRecipeSource, recipeMigratability, validateOptionValues } from "@lando/sdk/recipes";
import { RecipeSource, defineRecipe } from "@lando/sdk/schema";
import { Result, Schema } from "effect";

const context = { sourceKind: "local", packageName: "example", assets: [] } as const;
const source = { id: "example", title: "Example", description: "Example", version: "1.0.0", config: {} };

test("accepts author option drop declarations", () => {
  // Given
  const authored = { ...source, options: { removed: { drop: true } } };
  // When
  const parsed = Schema.decodeUnknownResult(RecipeSource)(authored, { onExcessProperty: "error" });
  // Then
  expect(Result.getOrThrow(parsed).options?.removed).toEqual({ drop: true });
});

test("omits unresolved drops from compiled options", () => {
  // Given
  const authored = {
    ...source,
    options: { removed: { drop: true }, enabled: { type: { kind: "boolean" }, default: false, prompt: {} } },
  };
  // When
  const compiled = compileRecipeSource(authored, context);
  // Then
  const manifest = Result.getOrThrow(compiled);
  expect(manifest.snapshot.optionTypes).toEqual({ enabled: { kind: "boolean" } });
  expect(manifest.snapshot.defaults).toEqual({ enabled: false });
  expect(manifest.prompts?.map((prompt) => prompt.name)).toEqual(["enabled"]);
});

test.each([
  { drop: true, type: { kind: "string" } },
  { drop: true, default: "private" },
  { drop: true, prompt: {} },
  { drop: true, disposition: { kind: "secret-store", field: "token" } },
  { drop: false },
])("rejects mixed or false option drops without silently stripping fields %#", (option) => {
  // Given
  const authored = { ...source, options: { removed: option } };
  // When
  const result = Schema.decodeUnknownResult(RecipeSource)(authored);
  // Then
  expect(Result.isFailure(result)).toBe(true);
});

test.each([
  { config: { "x-removed": "{{ recipe.removed }}" } },
  { variants: [{ when: "options.removed", config: {} }] },
])("rejects references to an unresolved dropped option %#", (extra) => {
  // Given
  const authored = { ...source, ...extra, options: { removed: { drop: true } } };
  // When
  const result = compileRecipeSource(authored, context);
  // Then
  expect(Result.isFailure(result)).toBe(true);
});

test("derives typed defaults and prompt descriptors when options are authored once", () => {
  // Given
  const authored = defineRecipe({
    ...source,
    options: {
      enabled: { type: { kind: "boolean" }, default: false, prompt: { message: "Enabled?" } },
      mode: { type: { kind: "enum", values: [false, "fast", 2] }, default: false, prompt: {} },
      ports: { type: { kind: "array", items: { kind: "number" } }, default: [80, 443], prompt: {} },
    },
  });
  // When
  const result = compileRecipeSource(authored, context);
  // Then
  expect(Result.isSuccess(result)).toBe(true);
  if (Result.isFailure(result)) return;
  expect(result.success.snapshot.defaults).toEqual({ enabled: false, mode: false, ports: [80, 443] });
  expect(result.success.prompts).toMatchObject([
    { name: "enabled", type: "confirm", default: false },
    { name: "mode", type: "select", default: false, choices: [false, "fast", 2] },
    { name: "ports", type: "multiselect", default: [80, 443] },
  ]);
});

test("retains missing required input while optional values may be absent", () => {
  // Given
  const result = compileRecipeSource(
    {
      ...source,
      options: {
        required: { type: { kind: "string" } },
        optional: { type: { kind: "optional", inner: { kind: "boolean" } } },
      },
    },
    context,
  );
  // When
  if (Result.isFailure(result)) throw result.failure;
  const missing = validateOptionValues(
    result.success.snapshot.optionTypes,
    result.success.snapshot.defaults,
    {},
  );
  const complete = validateOptionValues(result.success.snapshot.optionTypes, {}, { required: "yes" });
  // Then
  expect(missing).toMatchObject({ _tag: "Failure", failure: { reason: "option-type", path: "required" } });
  expect(complete).toMatchObject({ _tag: "Success", success: { required: "yes" } });
  expect(recipeMigratability(result.success, "local")).toEqual({ status: "migratable" });
});

test.each([
  { options: { name: { type: { kind: "string" } } } },
  { snapshot: {} },
  { prompts: [] },
  { options: { value: { type: { kind: "boolean" }, raw: "secret" } } },
  { options: { value: { type: { kind: "boolean" }, prompt: { when: "true" } } } },
  { options: { value: { type: { kind: "string" }, prompt: { validate: { pattern: "x" } } } } },
  { options: { value: { type: { kind: "string" }, prompt: { default: "x" } } } },
])("rejects unsupported author fields %#", (extra) => {
  // Given / When
  const result = Schema.decodeUnknownResult(RecipeSource)(
    { ...source, ...extra },
    { onExcessProperty: "error" },
  );
  // Then
  expect(Result.isFailure(result)).toBe(true);
});

test("rejects a mistyped default without copying its value into diagnostics", () => {
  // Given / When
  const result = compileRecipeSource(
    {
      ...source,
      options: {
        enabled: { type: { kind: "boolean" }, default: "private-value" },
      },
    },
    context,
  );
  // Then
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { reason: "option-default", path: "options.enabled.default" },
  });
  expect(JSON.stringify(result)).not.toContain("private-value");
});

test("excludes secret declarations from persistable options and checks their sink", () => {
  // Given
  const authored = {
    ...source,
    options: {
      token: {
        type: { kind: "secret" },
        disposition: { kind: "init-only", sink: { kind: "stdin" } },
        prompt: {},
      },
    },
    postInit: [{ type: "command", cmd: "login", stdin: { prompt: "token" } }],
  };
  // When
  const result = compileRecipeSource(authored, context);
  // Then
  expect(Result.isSuccess(result)).toBe(true);
  if (Result.isFailure(result)) return;
  expect(result.success.snapshot.optionTypes).toEqual({});
  expect(result.success.snapshot.defaults).toEqual({});
  expect(result.success.prompts).toMatchObject([
    { name: "token", type: "secret", disposition: { kind: "init-only" } },
  ]);
});

test.each([
  { type: { kind: "secret" }, default: "private-value", disposition: { kind: "secret-store", field: "db" } },
  { type: { kind: "secret" }, disposition: { kind: "init-only", sink: { kind: "stdin" } } },
])("rejects secret defaults or unresolved sinks %#", (token) => {
  // Given / When
  const result = compileRecipeSource({ ...source, options: { token } }, context);
  // Then
  expect(Result.isFailure(result)).toBe(true);
  expect(JSON.stringify(result)).not.toContain("private-value");
});

test("preserves enum false and rejects undeclared answer keys", () => {
  // Given
  const result = compileRecipeSource(
    {
      ...source,
      options: {
        mode: {
          type: { kind: "enum", values: [false, "fast"] },
          default: false,
        },
      },
    },
    context,
  );
  if (Result.isFailure(result)) throw result.failure;
  // When
  const valid = validateOptionValues(
    result.success.snapshot.optionTypes,
    result.success.snapshot.defaults,
    {},
  );
  const invalid = validateOptionValues(result.success.snapshot.optionTypes, {}, { extra: false });
  // Then
  expect(valid).toMatchObject({ _tag: "Success", success: { mode: false } });
  expect(invalid).toMatchObject({ _tag: "Failure", failure: { reason: "unsupported-option" } });
});

test("rejects action sinks bound to undeclared or nonsecret options", () => {
  // Given
  const sourceWithSink = {
    ...source,
    options: { token: { type: { kind: "string" }, default: "ordinary" } },
    postInit: [{ type: "command", cmd: "login", stdin: { prompt: "token" } }],
  };
  // When
  const result = compileRecipeSource(sourceWithSink, context);
  // Then
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { reason: "secret-invalid", path: "options.token" },
  });
});
