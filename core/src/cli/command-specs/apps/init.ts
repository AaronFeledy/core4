import { Effect } from "effect";
import { Args, Flags } from "../../spec/metadata";

import type { InitAppOptions } from "../../commands/init";
import { resolveInitDestination } from "../../commands/init-destination";
import { parseInitSourceFlags } from "../../commands/init-source";
import { mergeAnswerSources, parseAnswerFlags, resolveNonInteractive } from "../../prompts/answer-flags";
import { EmptyResultSchema, type LandoCommandSpec } from "../../spec/command-base";

/**
 * `lando apps:init` — interactive scaffolding for new Lando apps.
 *
 * **Interactive only** — not exported as a function from
 * `@lando/core/cli`; embedding hosts drive `InitSource` directly if needed.
 */

export interface InitFlags {
  readonly full: boolean;
  readonly name?: string;
  readonly recipe?: string;
  readonly source?: string;
  readonly url?: string;
  readonly id?: string;
  readonly "registry-url"?: string;
  readonly package?: string;
  readonly path?: string;
  readonly checksum?: string;
  readonly answer?: ReadonlyArray<string>;
  readonly option?: ReadonlyArray<string>;
  readonly answers?: string;
  readonly interactive?: boolean;
  readonly "no-interactive"?: boolean;
  readonly yes?: boolean;
}

export const initOptionsFromInput = (input: unknown): InitAppOptions => {
  const inputArgs = typeof input === "object" && input !== null && "args" in input ? input.args : undefined;
  const destination =
    typeof inputArgs === "object" && inputArgs !== null && "destination" in inputArgs
      ? inputArgs.destination
      : undefined;
  const flags: Partial<InitFlags> =
    typeof input === "object" && input !== null
      ? ((input as { readonly flags?: Partial<InitFlags> }).flags ?? {})
      : {};
  const answers = parseAnswerFlags(mergeAnswerSources(flags.answer, flags.option));
  const sourceOptions = parseInitSourceFlags({
    source: flags.source,
    url: flags.url,
    id: flags.id,
    package: flags.package,
    path: flags.path,
    checksum: flags.checksum,
  });
  const cwd = process.cwd();
  return {
    cwd,
    full: flags.full === true,
    answers,
    ...(flags.answers === undefined ? {} : { answersFile: flags.answers }),
    yes: flags.yes === true,
    nonInteractive: resolveNonInteractive({
      interactive: flags.interactive === true,
      noInteractive: flags["no-interactive"] === true,
      isTTY: process.stdin.isTTY,
    }),
    ...sourceOptions,
    destination: resolveInitDestination({
      cwd,
      ...(typeof destination === "string" ? { destination } : {}),
      ...(flags.name === undefined ? {} : { name: flags.name }),
    }),
    ...(flags.name === undefined ? {} : { name: flags.name }),
    ...(flags.recipe === undefined ? {} : { recipe: flags.recipe }),
    ...(flags["registry-url"] === undefined ? {} : { registryUrl: flags["registry-url"] }),
  };
};

export const initSpec: LandoCommandSpec<never> = {
  resultSchema: EmptyResultSchema,
  id: "apps:init",
  summary: "Generate a new Lando app.",
  namespace: "apps",
  topLevelAlias: true,
  aliases: ["init"],
  bootstrap: "minimal",
  args: {
    destination: Args.string({ description: "Output directory.", required: false, ignoreStdin: true }),
  },
  flags: {
    name: Flags.string({ description: "App name (slugified for the project id)." }),
    source: Flags.string({ description: "Init source id (cwd, git, tarball, npm, registry, template)." }),
    url: Flags.string({ description: "Remote recipe source URL (for --source=git/tarball)." }),
    id: Flags.string({ description: "Recipe id for --source=registry." }),
    "registry-url": Flags.string({
      description: "Override the recipe registry base URL (for --source=registry).",
    }),
    package: Flags.string({
      description: "npm package spec <name>[@version] (for --source=npm).",
    }),
    path: Flags.string({ description: "Subdirectory within a remote recipe source." }),
    checksum: Flags.string({
      description: "Expected SHA-256 of a --source=tarball archive (64 hex chars).",
    }),
    recipe: Flags.string({ description: "Recipe to apply." }),
    full: Flags.boolean({ description: "Use full recipe defaults instead of prompts." }),
    yes: Flags.boolean({ description: "Accept every prompt's default without asking.", default: false }),
    "no-interactive": Flags.boolean({
      aliases: ["non-interactive"],
      description:
        "Disable interactive prompting. Missing required answers fail with RecipeMissingAnswerError.",
      default: false,
    }),
    answer: Flags.string({
      description: "Recipe answer in key=value form (repeatable).",
      multiple: true,
    }),
    option: Flags.string({
      description: "Recipe option in key=value form (repeatable).",
      multiple: true,
    }),
    answers: Flags.string({ description: "Path to a JSON answers file." }),
    interactive: Flags.boolean({
      description: "Force interactive prompting even when stdin is not detected as a TTY.",
      default: false,
    }),
  },
  run: () => Effect.die("not yet implemented: apps:init"),
};
