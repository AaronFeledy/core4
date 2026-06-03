import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Either, Exit } from "effect";

import { LandofileParseError } from "@lando/core/errors";
import type { TemplateRenderContext } from "@lando/core/schema";
import { LandofileService } from "@lando/core/services";

import { LandofileServiceLive } from "../../src/landofile/service.ts";
import {
  bundledTemplateEngineRegistry,
  detectTemplateDirective,
  renderLandofileTemplate,
} from "../../src/landofile/template-render.ts";

const ctx = (env: Record<string, string> = {}): TemplateRenderContext => ({
  bootstrapLevel: "minimal",
  env,
  scope: "landofile",
});

const render = (filePath: string, content: string, context?: TemplateRenderContext) =>
  Effect.runPromise(
    renderLandofileTemplate({ filePath, content, context: context ?? ctx() }).pipe(Effect.either),
  );

describe("detectTemplateDirective", () => {
  test("matches a bare top-level `template:` first content line", () => {
    expect(detectTemplateDirective("template: handlebars\nname: x")).toEqual({
      engineId: "handlebars",
      lineIndex: 0,
    });
  });

  test("skips leading blank lines and comments before the directive", () => {
    const source = "\n# a comment\n\ntemplate: mustache\nname: x";
    expect(detectTemplateDirective(source)).toEqual({ engineId: "mustache", lineIndex: 3 });
  });

  test("a `# template:` comment is NOT a directive (bare key only)", () => {
    expect(detectTemplateDirective("# template: handlebars\nname: x")).toBeUndefined();
  });

  test("no directive when the first content line is a normal key", () => {
    expect(detectTemplateDirective("name: x\ntemplate: handlebars")).toBeUndefined();
  });

  test("an indented `template:` is not a directive", () => {
    expect(detectTemplateDirective("  template: handlebars\nname: x")).toBeUndefined();
  });

  test("the plural `templates:` key is not matched", () => {
    expect(detectTemplateDirective("templates: foo\nname: x")).toBeUndefined();
  });

  test("detects a directive on a CRLF (Windows) Landofile", () => {
    expect(detectTemplateDirective("template: handlebars\r\nname: x\r\n")).toEqual({
      engineId: "handlebars",
      lineIndex: 0,
    });
  });

  test("detects a directive after a CRLF comment + blank lines", () => {
    expect(detectTemplateDirective("# c\r\n\r\ntemplate: mustache\r\nname: x")).toEqual({
      engineId: "mustache",
      lineIndex: 2,
    });
  });

  test("detects a directive on a BOM-prefixed first line", () => {
    expect(detectTemplateDirective("\uFEFFtemplate: handlebars\nname: x")).toEqual({
      engineId: "handlebars",
      lineIndex: 0,
    });
  });
});

describe("renderLandofileTemplate (bundled engines)", () => {
  test("registry exposes the bundled handlebars + mustache engines", () => {
    expect([...bundledTemplateEngineRegistry.keys()].sort()).toEqual(["handlebars", "mustache"]);
  });

  test("renders a handlebars Landofile and strips the directive line", async () => {
    const result = await render(
      "/app/.lando.yml",
      "template: handlebars\nname: {{env.APP}}",
      ctx({ APP: "demo" }),
    );
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) expect(result.right).toBe("\nname: demo");
  });

  test("renders a mustache Landofile and strips the directive line", async () => {
    const result = await render(
      "/app/.lando.yml",
      "template: mustache\nname: {{env.APP}}",
      ctx({ APP: "demo" }),
    );
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) expect(result.right).toBe("\nname: demo");
  });

  test("renders a CRLF (Windows) handlebars Landofile end to end", async () => {
    const result = await render(
      "/app/.lando.yml",
      "template: handlebars\r\nname: {{env.APP}}\r\n",
      ctx({ APP: "demo" }),
    );
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) expect(result.right).toBe("\nname: demo\r\n");
  });

  test("default none: content without a directive is returned unchanged", async () => {
    const raw = "name: myapp\nservices:\n  web:\n    image: node:lts";
    const result = await render("/app/.lando.yml", raw);
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) expect(result.right).toBe(raw);
  });

  test("explicit `template: none` strips the directive and skips rendering", async () => {
    const result = await render("/app/.lando.yml", "template: none\nname: a && b {{x}}");
    expect(Either.isRight(result)).toBe(true);
    // The raw body is preserved verbatim (no rendering); only the directive is blanked.
    if (Either.isRight(result)) expect(result.right).toBe("\nname: a && b {{x}}");
  });

  test("an unknown engine fails with a LandofileParseError on the directive line", async () => {
    const result = await render("/app/.lando.yml", "template: nope\nname: x");
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(LandofileParseError);
      expect(result.left.line).toBe(1);
      expect(result.left.message).toContain("nope");
    }
  });

  test("the reserved `lando` engine is unresolved here (only handlebars+mustache bundled)", async () => {
    const result = await render("/app/.lando.yml", "template: lando\nname: x");
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(LandofileParseError);
  });

  test("a template syntax error surfaces the template-source line number", async () => {
    // Unclosed block — the directive is on line 1, the bad tag on line 3.
    const result = await render("/app/.lando.yml", "template: handlebars\nname: app\n{{#each items}}\n");
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(LandofileParseError);
      expect(typeof result.left.line).toBe("number");
      expect(result.left.line).toBeGreaterThanOrEqual(3);
    }
  });
});

const withTempCwd = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-template-render-"));
  const previousCwd = process.cwd();
  try {
    return await run(dir);
  } finally {
    process.chdir(previousCwd);
    await rm(dir, { recursive: true, force: true });
  }
};

const discoverExit = () =>
  Effect.runPromiseExit(
    Effect.flatMap(LandofileService, (service) => service.discover).pipe(
      Effect.provide(LandofileServiceLive),
    ),
  );

describe("LandofileService.discover renders templates before parse", () => {
  test("a handlebars Landofile renders, then decodes to a valid Landofile", async () => {
    process.env.LANDO_TEMPLATE_TEST_NAME = "rendered-app";
    try {
      await withTempCwd(async (dir) => {
        await writeFile(
          join(dir, ".lando.yml"),
          ["template: handlebars", "name: {{env.LANDO_TEMPLATE_TEST_NAME}}", "runtime: 4", ""].join("\n"),
        );
        process.chdir(dir);
        const exit = await discoverExit();
        expect(Exit.isSuccess(exit)).toBe(true);
        if (Exit.isSuccess(exit)) expect(exit.value.name).toBe("rendered-app");
      });
    } finally {
      Reflect.deleteProperty(process.env, "LANDO_TEMPLATE_TEST_NAME");
    }
  });

  test("a template syntax error fails discover with a LandofileParseError", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.yml"),
        ["template: handlebars", "name: app", "{{#each items}}", ""].join("\n"),
      );
      process.chdir(dir);
      const exit = await discoverExit();
      expect(Exit.isFailure(exit)).toBe(true);
    });
  });
});
