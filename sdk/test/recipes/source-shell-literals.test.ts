import { expect, test } from "bun:test";
import { evaluateTemplateEither } from "@lando/sdk/expressions";
import { compileRecipeSource, renderCompiledRecipeSnapshot } from "@lando/sdk/recipes";
import { AbsolutePath } from "@lando/sdk/schema";
import { Result } from "effect";

const context = { sourceKind: "local", packageName: "example", assets: [] } as const;
const base = { id: "example", title: "Example", description: "Example", version: "1.0.0" };
const renderContext = { appRoot: AbsolutePath.make("/app"), env: { HOME: "/host-home" } };

test("carries the recipe's authored service port expressions to planning", () => {
  const command = ["redis-server", "--port", "{{ service.port }}"];
  const environment = { PORT: "{{ service.port }}" };
  const config = { services: { cache: { type: "redis", command, environment } } };
  const manifest = Result.getOrThrow(compileRecipeSource({ ...base, config }, context));
  const compiled = Result.getOrThrow(renderCompiledRecipeSnapshot(manifest.snapshot, {}, renderContext));
  expect(compiled.document).toEqual(config);
  expect(compiled.pendingSites.map((site) => site.path)).toEqual([
    ["services", "cache", "command", 2],
    ["services", "cache", "environment", "PORT"],
  ]);
});

test.each([
  [{ port: "{{ service.port }}" }, ["port"]],
  [{ command: ["redis-server", "--port", "{{ service.name }}"] }, ["command", 2]],
] as const)("rejects a recipe self expression at %j (%j)", (service, path) => {
  const config = { services: { cache: { type: "redis", ...service } } };
  expect(compileRecipeSource({ ...base, config }, context)).toMatchObject({
    _tag: "Failure",
    failure: {
      _tag: "RecipeSourceCompileError",
      reason: "config-invalid",
      path: ["services", "cache", ...path],
    },
  });
});

test.each(["${HOME}", "${HOME:-fallback}", "${HOME-fallback}", "${HOME:?required}", "${HOME:+alt}"])(
  "rejects active shell syntax %s before emitting an unrenderable snapshot",
  (parameter) => {
    // Given
    const config = { services: { app: { type: "nginx", command: `echo ${parameter}` } } };
    // When
    const result = compileRecipeSource({ ...base, config }, context);
    // Then
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "RecipeSourceCompileError",
        reason: "config-invalid",
        path: ["services", "app", "command"],
      },
    });
  },
);

test("rejects active shell syntax even in an unselected binding-site variant", () => {
  // Given
  const source = {
    ...base,
    config: {},
    variants: [
      { when: "false", config: { services: { app: { type: "nginx", environment: { HOME: "${HOME}" } } } } },
    ],
  };
  // When
  const result = compileRecipeSource(source, context);
  // Then
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: {
      _tag: "RecipeSourceCompileError",
      reason: "config-invalid",
      path: ["services", "app", "environment", "HOME"],
    },
  });
});

test.each([
  ["echo $HOME", "echo $HOME"],
  ["echo $${HOME}", "echo ${HOME}"],
  ["echo $${HOME:-fallback}", "echo ${HOME:-fallback}"],
  ["echo $${secret:DB}", "echo ${secret:DB}"],
  ["echo {{{{ app.name }}", "echo {{ app.name }}"],
])("compiles and renders authored inert text %s without creating a binding", (command, expected) => {
  // Given
  const source = { ...base, config: { services: { app: { type: "nginx", command } } } };
  // When
  const manifest = Result.getOrThrow(compileRecipeSource(source, context));
  const compiled = Result.getOrThrow(renderCompiledRecipeSnapshot(manifest.snapshot, {}, renderContext));
  // Then
  expect(compiled.document).toEqual({ services: { app: { type: "nginx", command: expected } } });
  expect(compiled.pendingSites).toEqual([]);
});

test("keeps escaped shell and secret text inert beside an authored interpolation", () => {
  // Given
  const command = "echo $HOME $${HOME} $${secret:DB} {{ app.name }}";
  const source = { ...base, config: { services: { app: { type: "nginx", command } } } };
  // When
  const manifest = Result.getOrThrow(compileRecipeSource(source, context));
  const compiled = Result.getOrThrow(renderCompiledRecipeSnapshot(manifest.snapshot, {}, renderContext));
  const values = compiled.pendingSites.map((site) =>
    Result.getOrThrow(
      evaluateTemplateEither(site.template, { app: { name: "example" }, env: renderContext.env }),
    ),
  );
  // Then
  expect(compiled.pendingSites.map((site) => site.path)).toEqual([["services", "app", "command"]]);
  expect(values).toEqual(["echo $HOME ${HOME} ${secret:DB} example"]);
});
