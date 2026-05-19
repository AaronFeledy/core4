import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Effect } from "effect";

import { InitTargetExistsError } from "@lando/sdk/errors";
import { RecipeManifestService } from "@lando/sdk/services";

import { landofile, packageJson, serverJs } from "../../recipes/builtin/node-postgres/index.ts";
import {
  nodePostgresRecipeSource,
  nodePostgresRecipeYaml,
} from "../../recipes/builtin/node-postgres/manifest.ts";
import { RecipeManifestServiceLive } from "../../recipes/manifest/service.ts";
import {
  type PromptAnswers,
  type PromptIO,
  collectPrompts,
  createStdioPromptIO,
} from "../../recipes/prompts/index.ts";

const APP_NAME_PROMPT = "name";

export interface InitAppOptions {
  readonly cwd: string;
  readonly full: boolean;
  readonly name?: string;
  readonly answers?: Readonly<Record<string, string>>;
  readonly yes?: boolean;
  readonly nonInteractive?: boolean;
  readonly io?: PromptIO;
}

export interface InitAppResult {
  readonly appName: string;
  readonly directory: string;
  readonly answers: PromptAnswers;
}

const HARDCODED_FILE_RENDERERS: Record<string, (appName: string) => string> = {
  ".lando.yml": landofile,
  "package.json": packageJson,
  "server.js": () => serverJs,
};

const loadNodePostgresManifest = () =>
  Effect.runPromise(
    Effect.flatMap(RecipeManifestService, (svc) =>
      svc.parse(nodePostgresRecipeSource, nodePostgresRecipeYaml),
    ).pipe(Effect.provide(RecipeManifestServiceLive)),
  );

const composeAnswers = (options: InitAppOptions): Record<string, string> => {
  const out: Record<string, string> = { ...(options.answers ?? {}) };
  if (options.name !== undefined && options.name.trim() !== "") {
    out[APP_NAME_PROMPT] = options.name.trim();
  }
  return out;
};

const resolveIO = (options: InitAppOptions): PromptIO | undefined => {
  if (options.nonInteractive === true) return undefined;
  if (options.io !== undefined) return options.io;
  return createStdioPromptIO();
};

export const initApp = async (options: InitAppOptions): Promise<InitAppResult> => {
  const { cwd } = options;
  const manifest = await loadNodePostgresManifest();
  const prompts = manifest.prompts ?? [];

  const presetAnswers = composeAnswers(options);
  const io = resolveIO(options);
  const useDefaults = options.yes === true;

  const collected = await collectPrompts({
    prompts,
    answers: presetAnswers,
    yes: useDefaults,
    nonInteractive: options.nonInteractive === true || io === undefined,
    cwd,
    ...(io === undefined ? {} : { io }),
  });

  const appNameValue = collected[APP_NAME_PROMPT];
  if (typeof appNameValue !== "string" || appNameValue === "") {
    throw new Error("Built-in node-postgres recipe requires a text answer for prompt 'name'.");
  }
  const appName = appNameValue;

  const files = manifest.files ?? [];
  if (files.length === 0) {
    throw new Error("Built-in node-postgres recipe is missing a files: manifest.");
  }

  const directory = join(cwd, appName);
  const existing = await readdir(directory).catch((cause: unknown) => {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT")
      return undefined;
    throw cause;
  });

  if (existing !== undefined && existing.length > 0) {
    throw new InitTargetExistsError({
      message: `Init target already exists and is not empty: ${directory}`,
      path: directory,
      remediation: "Choose an empty directory or wait for Alpha --force support.",
    });
  }

  await mkdir(directory, { recursive: true });

  for (const file of files) {
    const renderer = HARDCODED_FILE_RENDERERS[file.dest];
    if (renderer === undefined) {
      throw new Error(
        `Built-in node-postgres recipe references an unknown destination "${file.dest}"; recipe rendering is not implemented yet.`,
      );
    }
    await writeFile(join(directory, file.dest), renderer(appName));
  }

  return { appName, directory, answers: collected };
};
