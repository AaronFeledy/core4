import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Schema } from "effect";

import { PluginManifest } from "@lando/sdk/schema";

export const PLUGIN_NEW_TEMPLATE_IDS = [
  "service-type",
  "provider",
  "tooling-engine",
  "template-engine",
  "route-filter",
  "config-translator",
  "recipe",
  "bare",
] as const;

export type PluginNewTemplateId = (typeof PLUGIN_NEW_TEMPLATE_IDS)[number];

export interface PluginNewResult {
  readonly name: string;
  readonly destination: string;
  readonly template: PluginNewTemplateId;
  readonly cspace: string;
  readonly files: ReadonlyArray<string>;
}

export const PluginNewResultSchema = Schema.Struct({
  name: Schema.String,
  destination: Schema.String,
  template: Schema.Literal(
    "service-type",
    "provider",
    "tooling-engine",
    "template-engine",
    "route-filter",
    "config-translator",
    "recipe",
    "bare",
  ),
  cspace: Schema.String,
  files: Schema.Array(Schema.String),
});

export interface PluginScaffoldInput {
  readonly name: string;
  readonly destination: string;
  readonly template: PluginNewTemplateId;
  readonly cspace: string;
  readonly description: string;
}

const contributionForTemplate = (
  template: PluginNewTemplateId,
  cspace: string,
): Record<string, unknown> | undefined => {
  const id = `${cspace}-example`;
  switch (template) {
    case "service-type":
      return { serviceTypes: [id] };
    case "provider":
      return { providers: [id] };
    case "template-engine":
      return { templateEngines: [id] };
    case "tooling-engine":
    case "route-filter":
    case "config-translator":
    case "recipe":
    case "bare":
      return undefined;
  }
};

const renderPackageJson = (input: PluginScaffoldInput): string => {
  const contributes = contributionForTemplate(input.template, input.cspace);
  const manifest = Schema.decodeSync(PluginManifest)({
    name: input.name,
    version: "0.0.0",
    api: 4,
    description: input.description,
    entry: "./src/index.ts",
    requires: { "@lando/core": "^4.0.0" },
    ...(contributes === undefined ? {} : { contributes }),
  });
  return `${JSON.stringify(
    {
      name: input.name,
      description: input.description,
      version: "0.0.0",
      type: "module",
      license: "MIT",
      main: "./src/index.ts",
      types: "./src/index.ts",
      exports: { ".": "./src/index.ts" },
      files: ["./src", "./dist", "!./dist/**/*.tsbuildinfo", "./plugin.yaml", "./README.md"],
      keywords: ["lando", "lando-plugin", `lando-${input.template}`],
      lando: { manifest: "./plugin.yaml" },
      landoPlugin: manifest,
      dependencies: {
        "@lando/sdk": "^4.0.0",
        effect: "^3.21.2",
      },
      devDependencies: {
        "@types/bun": "^1.4.0",
        typescript: "^5.6.0",
      },
      scripts: {
        test: "lando meta:plugin:test",
        build: "lando meta:plugin:build",
        link: "lando meta:plugin:link",
        typecheck: "tsc -b",
        clean: "rm -rf dist .tsbuildinfo",
      },
    },
    null,
    2,
  )}\n`;
};

const renderPluginYaml = (input: PluginScaffoldInput): string => {
  const contributes = contributionForTemplate(input.template, input.cspace);
  const lines = [
    `name: ${JSON.stringify(input.name)}`,
    "version: 0.0.0",
    "api: 4",
    `description: ${JSON.stringify(input.description)}`,
    "entry: ./src/index.ts",
    "requires:",
    '  "@lando/core": ^4.0.0',
  ];
  if (contributes !== undefined) {
    lines.push("contributes:");
    for (const [key, values] of Object.entries(contributes)) {
      lines.push(`  ${key}:`);
      for (const value of values as ReadonlyArray<string>) lines.push(`    - ${value}`);
    }
  }
  return `${lines.join("\n")}\n`;
};

const renderIndexTs = (input: PluginScaffoldInput): string => {
  const contributes = contributionForTemplate(input.template, input.cspace);
  return `import { Layer, Schema } from "effect";\n\nimport { PluginManifest } from "@lando/sdk/schema";\n\nimport { Config } from "./config";\n\nexport const PLUGIN_NAME = ${JSON.stringify(input.name)} as const;\n\nexport const manifest = Schema.decodeSync(PluginManifest)(${JSON.stringify(
    {
      name: input.name,
      version: "0.0.0",
      api: 4,
      description: input.description,
      entry: "./src/index.ts",
      requires: { "@lando/core": "^4.0.0" },
      ...(contributes === undefined ? {} : { contributes }),
    },
    null,
    2,
  )});\n\nexport const config = Config;\n\nexport const services = Layer.empty;\n`;
};

const renderConfigTs = (): string =>
  `import { Schema } from "effect";\n\nexport const Config = Schema.Struct({\n  enabled: Schema.optionalWith(Schema.Boolean, { default: () => true }),\n});\n\nexport type Config = typeof Config.Type;\n`;

const renderTest = (name: string): string =>
  `import { describe, expect, test } from "bun:test";\n\nimport { manifest } from "../src/index.ts";\n\ndescribe(${JSON.stringify(name)}, () => {\n  test("exports a Lando v4 plugin manifest", () => {\n    expect(manifest.name).toBe(${JSON.stringify(name)});\n    expect(manifest.api).toBe(4);\n    expect(manifest.requires?.["@lando/core"]).toBe("^4.0.0");\n  });\n});\n`;

const renderTsconfig = (): string =>
  `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        allowImportingTsExtensions: true,
        skipLibCheck: true,
        noEmit: true,
        declaration: true,
        rootDir: "./src",
        outDir: "./dist",
        tsBuildInfoFile: "./.tsbuildinfo",
        composite: true,
        types: ["bun"],
      },
      include: ["./src/**/*.ts"],
      exclude: ["./dist", "./node_modules"],
    },
    null,
    2,
  )}\n`;

const renderReadme = (input: PluginScaffoldInput): string =>
  `# ${input.name}\n\n${input.description}\n\nTemplate: \`${input.template}\`\nContribution namespace: \`${input.cspace}\`\n\n## Development\n\n- \`lando meta:plugin:test\` runs the plugin test suite.\n- \`lando meta:plugin:build\` builds publishable artifacts.\n- \`lando meta:plugin:link\` links this plugin into the local Lando plugin registry.\n`;

const renderFiles = (input: PluginScaffoldInput): Readonly<Record<string, string>> => ({
  "package.json": renderPackageJson(input),
  "plugin.yaml": renderPluginYaml(input),
  "src/index.ts": renderIndexTs(input),
  "src/config.ts": renderConfigTs(),
  "test/plugin.test.ts": renderTest(input.name),
  "tsconfig.json": renderTsconfig(),
  "README.md": renderReadme(input),
});

export const materializePluginScaffold = async (input: PluginScaffoldInput): Promise<PluginNewResult> => {
  const files = renderFiles(input);
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(input.destination, relativePath);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content);
  }
  return {
    name: input.name,
    destination: input.destination,
    template: input.template,
    cspace: input.cspace,
    files: Object.keys(files).sort(),
  };
};
