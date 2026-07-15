/**
 * `lando apps:init` — interactive scaffolding for new Lando apps.
 *
 * **Interactive only** — not exported as a function from
 * `@lando/core/cli`; embedding hosts drive `InitSource` directly if needed.
 */
import { Flags } from "@oclif/core";
import { Effect, Layer } from "effect";

import { NotImplementedError, RendererSelectionError } from "@lando/sdk/errors";

import { formatBugReport } from "../../../bug-report.ts";
import { parseInitSourceFlags } from "../../../commands/init-source.ts";
import { type InitAppOptions, type InitAppResult, initApp } from "../../../commands/init.ts";
import { type ResultFormat, resolveResultFormat } from "../../../format-flags.ts";
import {
  mergeAnswerSources,
  parseAnswerFlags,
  resolveNonInteractive,
} from "../../../prompts/answer-flags.ts";
import {
  makeRendererServiceLiveForMode,
  resolveCliDeprecationWarnings,
  resolveCliRendererMode,
  runWithRendererHandling,
  writeDiagnosticLine,
} from "../../../renderer-boundary.ts";
import type { RendererMode } from "../../../renderer-selection.ts";
import {
  EmptyResultSchema,
  LandoCommandBase,
  type LandoCommandSpec,
  resolveTopLevelAliases,
} from "../../command-base.ts";
import { renderCommandFlagValueValidation } from "../../command-boundary.ts";

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
  return {
    cwd: process.cwd(),
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
  bootstrap: "commands",
  run: () => Effect.die("not yet implemented: apps:init"),
};

export default class InitCommand extends LandoCommandBase {
  static override description = initSpec.summary;
  static override aliases = [...resolveTopLevelAliases(initSpec)];
  static override flags = {
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
    destination: Flags.string({ description: "Target directory." }),
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
  };
  static override landoSpec: LandoCommandSpec = initSpec;
  static override bootstrap = initSpec.bootstrap;

  override async run(): Promise<void> {
    // Remove --renderer before parsing because this command overrides run() and
    // never passes through runEffect, so the flag would be rejected.
    let rendererMode: RendererMode;
    try {
      const resolution = await resolveCliRendererMode({ argv: this.argv, env: process.env });
      rendererMode = resolution.mode;
      this.argv.length = 0;
      this.argv.push(...resolution.remainingArgv);
    } catch (error) {
      if (error instanceof RendererSelectionError || error instanceof NotImplementedError) {
        const text = formatBugReport({
          error,
          context: { commandId: "cli:renderer-selection" },
          rendererMode: "plain",
        });
        throw new Error(text);
      }
      throw error;
    }

    const deprecationWarnings = resolveCliDeprecationWarnings({ argv: this.argv, env: process.env });
    this.argv.length = 0;
    this.argv.push(...deprecationWarnings.remainingArgv);

    let resultFormat: ResultFormat = "text";
    try {
      const resolution = resolveResultFormat({ argv: this.argv, rendererMode });
      resultFormat = resolution.format;
      this.argv.length = 0;
      this.argv.push(...resolution.remainingArgv);
    } catch (error) {
      if (error instanceof RendererSelectionError) {
        throw new Error(
          formatBugReport({
            error,
            context: { commandId: "cli:format-selection" },
            rendererMode: "plain",
          }),
        );
      }
      throw error;
    }

    if (
      await renderCommandFlagValueValidation({
        commandId: initSpec.id,
        argv: this.argv,
        definitions: { ...this.ctor.baseFlags, ...this.ctor.flags },
        rendererMode,
        resultFormat,
        resultSchema: initSpec.resultSchema,
        deprecationWarnings: deprecationWarnings.enabled,
      })
    )
      return;

    const parsed = (await this.parse(InitCommand)) as { readonly flags: InitFlags };

    const options = {
      ...initOptionsFromInput(parsed),
      onWarn: (message: string) => {
        Effect.runSync(
          writeDiagnosticLine(message).pipe(Effect.provide(makeRendererServiceLiveForMode(rendererMode))),
        );
      },
    };
    await runWithRendererHandling(
      Effect.tryPromise({ try: () => initApp(options), catch: (error) => error }),
      {
        runtime: Layer.empty,
        rendererMode,
        resultFormat,
        command: initSpec.id,
        deprecationWarnings: deprecationWarnings.enabled,
        invocation: {
          commandId: initSpec.id,
          argv: this.argv,
          args: {},
          flags: Object.fromEntries(Object.entries(parsed.flags)),
          cwd: process.cwd(),
        },
        resultSchema: initSpec.resultSchema,
        render: (result: InitAppResult) => `Created ${result.appName} at ${result.directory}`,
        formatError: (error) => formatBugReport({ error, context: { commandId: initSpec.id }, rendererMode }),
      },
    );
  }
}
