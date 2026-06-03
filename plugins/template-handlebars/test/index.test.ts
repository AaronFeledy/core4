import { describe, expect, test } from "bun:test";
import { Effect, Either, Layer } from "effect";

import type { TemplateRenderContext } from "@lando/sdk/schema";
import { TemplateCompileError, TemplateRenderError } from "@lando/sdk/template";

import { PLUGIN_NAME, manifest, templateEngine, templateEngines } from "../src/index.ts";

const baseContext = (env: Record<string, string> = {}): TemplateRenderContext => ({
  bootstrapLevel: "minimal",
  env,
  scope: "landofile",
});

describe("@lando/template-handlebars plugin exports", () => {
  test("PLUGIN_NAME is the package name", () => {
    expect(PLUGIN_NAME).toBe("@lando/template-handlebars");
  });

  test("templateEngine is a Layer", () => {
    expect(Layer.isLayer(templateEngine)).toBe(true);
  });

  test("manifest declares the handlebars templateEngines contribution", () => {
    expect(manifest.name).toBe("@lando/template-handlebars");
    expect(manifest.api).toBe(4);
    expect(manifest.contributes?.templateEngines).toEqual(["handlebars"]);
  });

  test("templateEngines map yields the handlebars engine with whole-file capabilities", () => {
    expect(templateEngines).toBeInstanceOf(Map);
    const engine = templateEngines.get("handlebars");
    expect(engine).toBeDefined();
    if (engine === undefined) throw new Error("handlebars engine missing");
    expect(engine.id).toBe("handlebars");
    expect(engine.extensions).toEqual([".hbs", ".handlebars"]);
    expect(engine.capabilities).toEqual({
      wholeFile: true,
      stringInterpolation: false,
      partials: true,
      unsafe: false,
    });
  });

  test("compile + render substitutes context values without HTML escaping", async () => {
    const engine = templateEngines.get("handlebars");
    if (engine === undefined) throw new Error("handlebars engine missing");
    const compiled = await Effect.runPromise(
      engine.compile({ id: "/app/.lando.yml", source: "name: {{env.APP}}\nflag: a && b" }),
    );
    const rendered = await Effect.runPromise(engine.render(compiled, baseContext({ APP: "demo" })));
    // noEscape: true — the `&&` must survive untouched (not `&amp;&amp;`).
    expect(rendered).toBe("name: demo\nflag: a && b");
  });

  test("syntax error fails compile with the template-source line number", async () => {
    const engine = templateEngines.get("handlebars");
    if (engine === undefined) throw new Error("handlebars engine missing");
    // Unclosed block on source line 3.
    const source = "name: app\nlist:\n  {{#each items}}\n";
    const result = await Effect.runPromise(
      engine.compile({ id: "/app/.lando.yml", source }).pipe(Effect.either),
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(TemplateCompileError);
      expect(result.left.engineId).toBe("handlebars");
      expect(typeof result.left.line).toBe("number");
    }
  });

  test("strict mode fails render on a missing field", async () => {
    const engine = templateEngines.get("handlebars");
    if (engine === undefined) throw new Error("handlebars engine missing");
    const compiled = await Effect.runPromise(
      engine.compile({ id: "/app/.lando.yml", source: "name: {{env.MISSING}}" }),
    );
    const result = await Effect.runPromise(engine.render(compiled, baseContext()).pipe(Effect.either));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(TemplateRenderError);
    }
  });
});
