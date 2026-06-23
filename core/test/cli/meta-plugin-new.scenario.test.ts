import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { Readable, Writable } from "node:stream";

import {
  PLUGIN_NEW_TEMPLATE_IDS,
  pluginNew,
  renderPluginNewResult,
} from "../../src/cli/commands/plugin-new.ts";
import type { InteractionPrompter } from "../../src/interaction/prompter.ts";
import { makeInteractionService } from "../../src/interaction/service.ts";
import { listTree } from "./_util/fs-tree.ts";

const scriptedStdin = (lines: ReadonlyArray<string>): NodeJS.ReadableStream =>
  Readable.from(lines.map((line) => `${line}\n`));

const capturingWritable = () => {
  let text = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  return { stream, text: () => text };
};

const serviceBackedPrompter = (
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream,
): InteractionPrompter => {
  const service = makeInteractionService({ stdin, stdout });
  return {
    promptAll: (specs, options) =>
      Effect.runPromise(Effect.scoped(service.promptAll(specs, { ...options, mode: "interactive" }))),
    confirm: (spec) => Effect.runPromise(Effect.scoped(service.confirm({ ...spec, mode: "interactive" }))),
  };
};

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
  test("scaffolds only into the destination and never mutates global state under userDataRoot", async () => {
    const destination = join(root, "demo-plugin");
    const dataRoot = join(root, "data");
    const previous = process.env.LANDO_USER_DATA_ROOT;
    process.env.LANDO_USER_DATA_ROOT = dataRoot;
    try {
      await Effect.runPromise(
        pluginNew({
          name: "@acme/lando-plugin-contained",
          destination,
          template: "bare",
          cspace: "acme",
          description: "Contained plugin",
          nonInteractive: true,
        }),
      );
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
      else process.env.LANDO_USER_DATA_ROOT = previous;
    }

    expect(await exists(join(destination, "package.json"))).toBe(true);
    expect(listTree(dataRoot)).toEqual([]);
  });

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
    const stdout = capturingWritable();
    const interaction = serviceBackedPrompter(
      scriptedStdin([
        "@acme/lando-plugin-interactive",
        "template-engine",
        "interactive",
        "Interactive plugin",
      ]),
      stdout.stream,
    );

    const result = await Effect.runPromise(
      pluginNew({
        destination: join(root, "interactive-plugin"),
        interaction,
      }),
    );

    expect(result.name).toBe("@acme/lando-plugin-interactive");
    expect(result.template).toBe("template-engine");
    expect(result.cspace).toBe("interactive");
    expect(stdout.text()).toContain("Plugin package name");
    expect(stdout.text()).toContain("Template");
    expect(stdout.text()).toContain("Contribution namespace");
    expect(stdout.text()).toContain("Description");
  });
});
