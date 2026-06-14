import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import {
  PLUGIN_NEW_TEMPLATE_IDS,
  pluginNew,
  renderPluginNewResult,
} from "../../src/cli/commands/plugin-new.ts";
import { createBufferedPromptIO } from "../../src/recipes/prompts/io.ts";

let root: string;

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-plugin-new-"));
});

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

describe("meta:plugin:new command", () => {
  test("scaffolds a non-interactive bare plugin with manifest, config schema, tests, tsconfig, and README", async () => {
    const destination = join(root, "demo-plugin");

    const result = await Effect.runPromise(
      pluginNew({
        name: "@acme/lando-plugin-demo",
        destination,
        template: "bare",
        cspace: "acme",
        description: "Demo plugin",
        nonInteractive: true,
      }),
    );

    expect(result.template).toBe("bare");
    expect(result.destination).toBe(destination);
    expect(renderPluginNewResult(result)).toContain("scaffolded-plugin: @acme/lando-plugin-demo");

    const packageJson = JSON.parse(await readFile(join(destination, "package.json"), "utf8")) as {
      name?: string;
      landoPlugin?: {
        api?: number;
        requires?: Record<string, string>;
        contributes?: Record<string, unknown>;
      };
      scripts?: Record<string, string>;
    };
    expect(packageJson.name).toBe("@acme/lando-plugin-demo");
    expect(packageJson.landoPlugin?.api).toBe(4);
    expect(packageJson.landoPlugin?.requires?.["@lando/core"]).toBe("^4.0.0");
    expect(packageJson.scripts?.test).toBe("lando meta:plugin:test");
    expect(packageJson.scripts?.build).toBe("lando meta:plugin:build");
    expect(packageJson.scripts?.link).toBe("lando meta:plugin:link");

    const pluginYaml = await readFile(join(destination, "plugin.yaml"), "utf8");
    expect(pluginYaml).toContain('name: "@acme/lando-plugin-demo"');

    expect(await exists(join(destination, "src", "index.ts"))).toBe(true);
    expect(await exists(join(destination, "src", "config.ts"))).toBe(true);
    expect(await exists(join(destination, "test", "plugin.test.ts"))).toBe(true);
    expect(await exists(join(destination, "tsconfig.json"))).toBe(true);
    expect(await exists(join(destination, "README.md"))).toBe(true);

    const source = await readFile(join(destination, "src", "index.ts"), "utf8");
    expect(source).toContain("Schema.decodeSync(PluginManifest)");
    expect(source).toContain("@acme/lando-plugin-demo");
  });

  test("every bundled plugin template id scaffolds a package without reading runtime template files", async () => {
    for (const template of PLUGIN_NEW_TEMPLATE_IDS) {
      const destination = join(root, template);
      const result = await Effect.runPromise(
        pluginNew({
          name: `@acme/lando-plugin-${template}`,
          destination,
          template,
          cspace: "acme",
          description: `${template} plugin`,
          nonInteractive: true,
        }),
      );

      expect(result.template).toBe(template);
      expect(await exists(join(destination, "package.json"))).toBe(true);
      expect(await exists(join(destination, "src", "index.ts"))).toBe(true);
      const packageJson = JSON.parse(await readFile(join(destination, "package.json"), "utf8")) as {
        landoPlugin?: { contributes?: Record<string, unknown> };
      };
      expect(Object.keys(packageJson.landoPlugin?.contributes ?? {}).sort()).toEqual(
        template === "service-type"
          ? ["serviceTypes"]
          : template === "provider"
            ? ["providers"]
            : template === "template-engine"
              ? ["templateEngines"]
              : [],
      );
    }
  });

  test("non-interactive mode requires template, cspace, and description before writing files", async () => {
    const destination = join(root, "incomplete");

    const exit = await Effect.runPromiseExit(
      pluginNew({
        name: "@acme/lando-plugin-incomplete",
        destination,
        nonInteractive: true,
      }),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Success") throw new Error("Expected pluginNew to fail");
    expect(JSON.stringify(exit.cause)).toContain("template");
    expect(JSON.stringify(exit.cause)).toContain("cspace");
    expect(JSON.stringify(exit.cause)).toContain("description");
    expect(await exists(destination)).toBe(false);
  });

  test("non-interactive answers can come from repeatable flags and an answers file", async () => {
    const answersFile = join(root, "answers.json");
    const destination = join(root, "answers-plugin");
    await writeFile(
      answersFile,
      JSON.stringify({ template: "provider", cspace: "file", description: "File description" }),
    );

    const result = await Effect.runPromise(
      pluginNew({
        name: "@acme/lando-plugin-answers",
        destination,
        answers: ["cspace=flag", "description=Flag description"],
        answersFile,
        nonInteractive: true,
      }),
    );

    expect(result.template).toBe("provider");
    expect(result.cspace).toBe("flag");
    const packageJson = JSON.parse(await readFile(join(destination, "package.json"), "utf8")) as {
      description?: string;
      landoPlugin?: { contributes?: Record<string, ReadonlyArray<string>> };
    };
    expect(packageJson.description).toBe("Flag description");
    expect(packageJson.landoPlugin?.contributes?.providers).toEqual(["flag-example"]);
  });

  test("interactive mode prompts for name, template, cspace, and description", async () => {
    const io = createBufferedPromptIO({
      inputs: ["@acme/lando-plugin-interactive", "template-engine", "interactive", "Interactive plugin"],
      isTTY: true,
    });

    const result = await Effect.runPromise(
      pluginNew({
        destination: join(root, "interactive-plugin"),
        promptIO: io,
      }),
    );

    expect(result.name).toBe("@acme/lando-plugin-interactive");
    expect(result.template).toBe("template-engine");
    expect(result.cspace).toBe("interactive");
    expect(io.stdout()).toContain("Plugin package name");
    expect(io.stdout()).toContain("Template");
    expect(io.stdout()).toContain("Contribution namespace");
    expect(io.stdout()).toContain("Description");
  });
});
