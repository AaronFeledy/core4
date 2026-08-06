import { describe, expect, test } from "bun:test";
import { Effect, Either, Schema } from "effect";

import { LandofileParseError } from "@lando/sdk/errors";
import type { LandoPluginModule } from "@lando/sdk/plugins";
import type { TemplateRenderContext } from "@lando/sdk/schema";
import { PluginManifest } from "@lando/sdk/schema";
import type { CompiledTemplate, TemplateEngine } from "@lando/sdk/template";

import { buildTemplateEngineRegistry, renderLandofileTemplate } from "../src/template-render.ts";

const ctx = (env: Record<string, string> = {}): TemplateRenderContext => ({
  bootstrapLevel: "minimal",
  env,
  scope: "landofile",
});

const fakeEngine = (id: string): TemplateEngine => ({
  id,
  extensions: [`.${id}`],
  capabilities: {
    wholeFile: true,
    stringInterpolation: false,
    partials: false,
    unsafe: false,
  },
  compile: (input) =>
    Effect.succeed({
      engineId: id,
      sourceId: input.id,
      run: (context: TemplateRenderContext) => input.source.replaceAll("{{env.APP}}", context.env.APP ?? ""),
    } satisfies CompiledTemplate),
  render: (template, context) => Effect.succeed(template.run(context)),
});

const moduleWithEngine = (name: string, engineId: string): LandoPluginModule => ({
  name,
  manifest: Schema.decodeSync(PluginManifest)({
    name,
    version: "1.0.0",
    api: 4,
    contributes: { templateEngines: [engineId] },
  }),
  templateEngines: new Map([[engineId, fakeEngine(engineId)]]),
});

const moduleWithoutEngines = (name: string): LandoPluginModule => ({
  name,
  manifest: Schema.decodeSync(PluginManifest)({
    name,
    version: "1.0.0",
    api: 4,
  }),
});

describe("buildTemplateEngineRegistry (injected modules)", () => {
  test("resolves engines from injected descriptor modules", () => {
    // Given: fake modules, one contributing a template engine.
    const modules = [
      moduleWithoutEngines("@lando/no-engines"),
      moduleWithEngine("@lando/fake-engine", "fake"),
    ];

    // When: a registry is built from those modules.
    const registry = buildTemplateEngineRegistry(modules);

    // Then: only the contributed engine is present.
    expect([...registry.keys()]).toEqual(["fake"]);
    expect(registry.get("fake")?.id).toBe("fake");
  });

  test("first-wins when two modules contribute the same engine id", () => {
    // Given: two modules providing the same id with distinct engine objects.
    const first = fakeEngine("shared");
    const second = fakeEngine("shared");
    const modules: ReadonlyArray<LandoPluginModule> = [
      {
        name: "@lando/first",
        manifest: Schema.decodeSync(PluginManifest)({
          name: "@lando/first",
          version: "1.0.0",
          api: 4,
          contributes: { templateEngines: ["shared"] },
        }),
        templateEngines: new Map([["shared", first]]),
      },
      {
        name: "@lando/second",
        manifest: Schema.decodeSync(PluginManifest)({
          name: "@lando/second",
          version: "1.0.0",
          api: 4,
          contributes: { templateEngines: ["shared"] },
        }),
        templateEngines: new Map([["shared", second]]),
      },
    ];

    // When: a registry is built.
    const registry = buildTemplateEngineRegistry(modules);

    // Then: the first contributor wins.
    expect(registry.get("shared")).toBe(first);
  });
});

describe("renderLandofileTemplate (injected module registry)", () => {
  test("renders via an engine contributed by injected modules", async () => {
    // Given: a registry built from a fake handlebars-like module.
    const registry = buildTemplateEngineRegistry([moduleWithEngine("@lando/fake-hb", "fakehb")]);

    // When: a Landofile declares that engine.
    const result = await Effect.runPromise(
      renderLandofileTemplate({
        filePath: "/app/.lando.yml",
        content: "template: fakehb\nname: {{env.APP}}",
        registry,
        context: ctx({ APP: "demo" }),
      }).pipe(Effect.either),
    );

    // Then: the injected engine renders and the directive line is blanked.
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) expect(result.right).toBe("\nname: demo");
  });

  test("unknown engine fails with LandofileParseError when modules lack it", async () => {
    // Given: modules that only contribute `known`.
    const registry = buildTemplateEngineRegistry([moduleWithEngine("@lando/known", "known")]);

    // When: the Landofile asks for an engine not in those modules.
    const result = await Effect.runPromise(
      renderLandofileTemplate({
        filePath: "/app/.lando.yml",
        content: "template: nope\nname: x",
        registry,
        context: ctx(),
      }).pipe(Effect.either),
    );

    // Then: unknown-engine error is preserved on the directive line.
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(LandofileParseError);
      expect(result.left.line).toBe(1);
      expect(result.left.message).toContain("nope");
      expect(result.left.message).toContain("known");
    }
  });
});
