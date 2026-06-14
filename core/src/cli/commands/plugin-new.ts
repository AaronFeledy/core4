import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { Effect, Schema } from "effect";

import { NotImplementedError } from "@lando/sdk/errors";
import { PluginManifest } from "@lando/sdk/schema";

import { parseAnswerFlags } from "../../recipes/prompts/index.ts";
import { type PromptIO, createStdioPromptIO } from "../../recipes/prompts/io.ts";

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

export interface PluginNewOptions {
  readonly name?: string | undefined;
  readonly destination?: string | undefined;
  readonly template?: string | undefined;
  readonly cspace?: string | undefined;
  readonly description?: string | undefined;
  readonly answers?: ReadonlyArray<string> | undefined;
  readonly answersFile?: string | undefined;
  readonly nonInteractive?: boolean;
  readonly cwd?: string | undefined;
  readonly promptIO?: PromptIO | undefined;
}

export interface PluginNewResult {
  readonly name: string;
  readonly destination: string;
  readonly template: PluginNewTemplateId;
  readonly cspace: string;
  readonly files: ReadonlyArray<string>;
}

const TEMPLATE_SET = new Set<string>(PLUGIN_NEW_TEMPLATE_IDS);

const isPluginNewTemplateId = (value: string): value is PluginNewTemplateId => TEMPLATE_SET.has(value);

const commandError = (message: string, remediation: string): NotImplementedError =>
  new NotImplementedError({ message, commandId: "meta:plugin:new", remediation });

const packageDirectoryName = (name: string): string => basename(name).replace(/^lando-plugin-/, "plugin-");

const defaultCspace = (name: string): string => {
  if (!name.startsWith("@")) return "lando";
  const slash = name.indexOf("/");
  if (slash <= 1) return "lando";
  return name.slice(1, slash);
};

const validPluginName = (name: string): boolean => /^(@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/i.test(name);

const parseAnswersFile = async (path: string): Promise<Record<string, string>> => {
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw commandError(
      "Plugin scaffold answers file must contain a JSON object.",
      'Write --answers as JSON, for example {"template":"bare"}.',
    );
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string") {
      throw commandError(
        `Plugin scaffold answer "${key}" must be a string.`,
        "Use string values for name, template, cspace, and description.",
      );
    }
    out[key] = value;
  }
  return out;
};

const readAnswer = async (io: PromptIO, message: string, fallback?: string): Promise<string> => {
  const suffix = fallback === undefined ? "" : ` [${fallback}]`;
  io.write(`${message}${suffix}: `);
  const raw = (await io.readLine()).trim();
  return raw === "" && fallback !== undefined ? fallback : raw;
};

interface ResolvedPluginNewOptions {
  readonly name: string;
  readonly destination: string;
  readonly template: PluginNewTemplateId;
  readonly cspace: string;
  readonly description: string;
}

const resolvePluginNewOptions = async (options: PluginNewOptions): Promise<ResolvedPluginNewOptions> => {
  const cwd = options.cwd ?? process.cwd();
  const fileAnswers =
    options.answersFile === undefined ? {} : await parseAnswersFile(resolve(cwd, options.answersFile));
  const flagAnswers = parseAnswerFlags(options.answers ?? []);
  const answers = { ...fileAnswers, ...flagAnswers };
  const io = options.promptIO ?? createStdioPromptIO();
  const nonInteractive = options.nonInteractive === true || io.isTTY !== true;

  let name = options.name ?? answers.name;
  let template = options.template ?? answers.template;
  let cspace = options.cspace ?? answers.cspace;
  let description = options.description ?? answers.description;

  if (!nonInteractive) {
    name = name ?? (await readAnswer(io, "Plugin package name"));
    template = template ?? (await readAnswer(io, "Template", "bare"));
    cspace = cspace ?? (await readAnswer(io, "Contribution namespace", defaultCspace(name)));
    description = description ?? (await readAnswer(io, "Description", `${name} plugin`));
  }

  const missing = [
    ["name", name],
    ["template", template],
    ["cspace", cspace],
    ["description", description],
  ]
    .filter(([, value]) => value === undefined || value.trim() === "")
    .map(([key]) => key);
  if (missing.length > 0) {
    throw commandError(
      `Plugin scaffold is missing required non-interactive value(s): ${missing.join(", ")}.`,
      "Provide missing values as arguments, --template/--cspace/--description, repeatable --answer key=value, or --answers <file>.",
    );
  }

  const resolvedName = name as string;
  const resolvedTemplate = template as string;
  const resolvedCspace = cspace as string;
  const resolvedDescription = description as string;

  if (!validPluginName(resolvedName)) {
    throw commandError(
      `Invalid plugin package name "${resolvedName}".`,
      "Use an npm package name such as @acme/lando-plugin-demo.",
    );
  }
  if (!isPluginNewTemplateId(resolvedTemplate)) {
    throw commandError(
      `Unknown plugin template "${resolvedTemplate}".`,
      `Choose one of: ${PLUGIN_NEW_TEMPLATE_IDS.join(", ")}.`,
    );
  }
  const destination = resolve(
    cwd,
    options.destination ?? answers.destination ?? packageDirectoryName(resolvedName),
  );
  return {
    name: resolvedName,
    destination,
    template: resolvedTemplate,
    cspace: resolvedCspace,
    description: resolvedDescription,
  };
};

const targetMustNotExist = async (destination: string): Promise<void> => {
  const exists = await stat(destination).then(
    (entry) => entry.isDirectory(),
    () => false,
  );
  if (!exists) return;
  const entries = await readdir(destination);
  if (entries.length > 0) {
    throw commandError(
      `Plugin scaffold destination already exists and is not empty: ${destination}.`,
      "Choose an empty destination directory. Overwriting scaffolds is not supported in Beta 1.",
    );
  }
};

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

const renderPackageJson = (input: ResolvedPluginNewOptions): string => {
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
        "@types/bun": "^1.3.14",
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

const renderPluginYaml = (input: ResolvedPluginNewOptions): string => {
  const contributes = contributionForTemplate(input.template, input.cspace);
  const lines = [
    `name: ${input.name}`,
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

const renderIndexTs = (input: ResolvedPluginNewOptions): string => {
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

const renderReadme = (input: ResolvedPluginNewOptions): string =>
  `# ${input.name}\n\n${input.description}\n\nTemplate: \`${input.template}\`\nContribution namespace: \`${input.cspace}\`\n\n## Development\n\n- \`lando meta:plugin:test\` runs the plugin test suite.\n- \`lando meta:plugin:build\` builds publishable artifacts.\n- \`lando meta:plugin:link\` links this plugin into the local Lando plugin registry.\n`;

const renderFiles = (input: ResolvedPluginNewOptions): Readonly<Record<string, string>> => ({
  "package.json": renderPackageJson(input),
  "plugin.yaml": renderPluginYaml(input),
  "src/index.ts": renderIndexTs(input),
  "src/config.ts": renderConfigTs(),
  "test/plugin.test.ts": renderTest(input.name),
  "tsconfig.json": renderTsconfig(),
  "README.md": renderReadme(input),
});

export const pluginNew = (
  options: PluginNewOptions,
): Effect.Effect<PluginNewResult, NotImplementedError, never> =>
  Effect.tryPromise({
    try: async () => {
      const resolved = await resolvePluginNewOptions(options);
      await targetMustNotExist(resolved.destination);
      const files = renderFiles(resolved);
      for (const [relativePath, content] of Object.entries(files)) {
        const target = join(resolved.destination, relativePath);
        await mkdir(join(target, ".."), { recursive: true });
        await writeFile(target, content);
      }
      return {
        name: resolved.name,
        destination: resolved.destination,
        template: resolved.template,
        cspace: resolved.cspace,
        files: Object.keys(files).sort(),
      };
    },
    catch: (error) =>
      error instanceof NotImplementedError
        ? error
        : commandError("Unable to scaffold plugin.", error instanceof Error ? error.message : String(error)),
  });

export const renderPluginNewResult = (result: PluginNewResult): string =>
  [
    `scaffolded-plugin: ${result.name}`,
    `template: ${result.template}`,
    `destination: ${result.destination}`,
    `files: ${result.files.length}`,
  ].join("\n");
