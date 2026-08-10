import { readFile, readdir, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { Effect } from "effect";

import { NotImplementedError } from "@lando/sdk/errors";
import type { PromptSpec } from "@lando/sdk/schema";

import {
  PLUGIN_NEW_TEMPLATE_IDS,
  type PluginNewResult,
  type PluginNewTemplateId,
  type PluginScaffoldInput,
  materializePluginScaffold,
} from "@lando/engine/operations/plugin-scaffold";

import { type InteractionPrompter, makePromiseInteractionPrompter } from "../../interaction/prompter";
import { makeInteractionService } from "../../interaction/service";
import { parseAnswerFlags } from "../../recipes/prompts/index";

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
  readonly interaction?: InteractionPrompter | undefined;
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

const NAME_PROMPT = "name";
const TEMPLATE_PROMPT = "template";
const CSPACE_PROMPT = "cspace";
const DESCRIPTION_PROMPT = "description";

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const defaultInteractionPrompter = (): InteractionPrompter =>
  makePromiseInteractionPrompter(makeInteractionService());

const resolvePluginNewOptions = async (options: PluginNewOptions): Promise<PluginScaffoldInput> => {
  const cwd = options.cwd ?? process.cwd();
  const fileAnswers =
    options.answersFile === undefined ? {} : await parseAnswersFile(resolve(cwd, options.answersFile));
  const flagAnswers = parseAnswerFlags(options.answers ?? []);
  const answers = { ...fileAnswers, ...flagAnswers };
  const nonInteractive = options.nonInteractive === true;
  const prompter = nonInteractive ? undefined : (options.interaction ?? defaultInteractionPrompter());

  let name = options.name ?? answers.name;
  let template = options.template ?? answers.template;
  let cspace = options.cspace ?? answers.cspace;
  let description = options.description ?? answers.description;

  if (prompter !== undefined) {
    // Name resolves first because cspace/description defaults derive from it.
    if (name === undefined) {
      const named = await prompter.promptAll([
        { name: NAME_PROMPT, type: "text", message: "Plugin package name" },
      ]);
      name = asString(named[NAME_PROMPT]);
    }
    const resolvedName = name ?? "";
    const specs: ReadonlyArray<PromptSpec> = [
      ...(template === undefined
        ? [{ name: TEMPLATE_PROMPT, type: "text", message: "Template", default: "bare" } as PromptSpec]
        : []),
      ...(cspace === undefined
        ? [
            {
              name: CSPACE_PROMPT,
              type: "text",
              message: "Contribution namespace",
              default: defaultCspace(resolvedName),
            } as PromptSpec,
          ]
        : []),
      ...(description === undefined
        ? [
            {
              name: DESCRIPTION_PROMPT,
              type: "text",
              message: "Description",
              default: `${resolvedName} plugin`,
            } as PromptSpec,
          ]
        : []),
    ];
    if (specs.length > 0) {
      const collected = await prompter.promptAll(specs);
      template = template ?? asString(collected[TEMPLATE_PROMPT]);
      cspace = cspace ?? asString(collected[CSPACE_PROMPT]);
      description = description ?? asString(collected[DESCRIPTION_PROMPT]);
    }
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

export const pluginNew = (
  options: PluginNewOptions,
): Effect.Effect<PluginNewResult, NotImplementedError, never> =>
  Effect.tryPromise({
    try: async () => {
      const resolved = await resolvePluginNewOptions(options);
      await targetMustNotExist(resolved.destination);
      return await materializePluginScaffold(resolved);
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
