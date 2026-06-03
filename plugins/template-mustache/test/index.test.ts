import { describe, expect, test } from "bun:test";
import { Effect, Either, Layer } from "effect";
import Mustache from "mustache";

import type { TemplateRenderContext } from "@lando/sdk/schema";
import { TemplateCompileError } from "@lando/sdk/template";

import { PLUGIN_NAME, manifest, templateEngine, templateEngines } from "../src/index.ts";

const baseContext = (env: Record<string, string> = {}): TemplateRenderContext => ({
  bootstrapLevel: "minimal",
  env,
  scope: "landofile",
});

describe("@lando/template-mustache plugin exports", () => {
  test("PLUGIN_NAME is the package name", () => {
    expect(PLUGIN_NAME).toBe("@lando/template-mustache");
  });

  test("templateEngine is a Layer", () => {
    expect(Layer.isLayer(templateEngine)).toBe(true);
  });

  test("manifest declares the mustache templateEngines contribution", () => {
    expect(manifest.name).toBe("@lando/template-mustache");
    expect(manifest.api).toBe(4);
    expect(manifest.contributes?.templateEngines).toEqual(["mustache"]);
  });

  test("templateEngines map yields the mustache engine, logic-less (no partials)", () => {
    expect(templateEngines).toBeInstanceOf(Map);
    const engine = templateEngines.get("mustache");
    expect(engine).toBeDefined();
    if (engine === undefined) throw new Error("mustache engine missing");
    expect(engine.id).toBe("mustache");
    expect(engine.extensions).toEqual([".mustache"]);
    expect(engine.capabilities).toEqual({
      wholeFile: true,
      stringInterpolation: false,
      partials: false,
      unsafe: false,
    });
  });

  test("compile + render substitutes context values without HTML escaping", async () => {
    const engine = templateEngines.get("mustache");
    if (engine === undefined) throw new Error("mustache engine missing");
    const compiled = await Effect.runPromise(
      engine.compile({ id: "/app/.lando.yml", source: "name: {{env.APP}}\nflag: a && b" }),
    );
    const rendered = await Effect.runPromise(engine.render(compiled, baseContext({ APP: "demo" })));
    // No HTML escaping — `&&` survives untouched.
    expect(rendered).toBe("name: demo\nflag: a && b");
  });

  test("importing the plugin does not mutate the process-global Mustache.escape", () => {
    expect(Mustache.render("{{x}}", { x: "&" })).toBe("&amp;");
  });

  test("missing key renders empty (logic-less, no strict mode)", async () => {
    const engine = templateEngines.get("mustache");
    if (engine === undefined) throw new Error("mustache engine missing");
    const compiled = await Effect.runPromise(
      engine.compile({ id: "/app/.lando.yml", source: "name: {{env.MISSING}}x" }),
    );
    const rendered = await Effect.runPromise(engine.render(compiled, baseContext()));
    expect(rendered).toBe("name: x");
  });

  test("malformed tag fails compile with the template-source line number", async () => {
    const engine = templateEngines.get("mustache");
    if (engine === undefined) throw new Error("mustache engine missing");
    // Unclosed section beginning on source line 3.
    const source = "name: app\nlist:\n  {{#items}}\n";
    const result = await Effect.runPromise(
      engine.compile({ id: "/app/.lando.yml", source }).pipe(Effect.either),
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(TemplateCompileError);
      expect(result.left.engineId).toBe("mustache");
      expect(typeof result.left.line).toBe("number");
    }
  });
});
