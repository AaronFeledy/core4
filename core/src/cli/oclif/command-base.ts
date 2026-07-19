import { Command } from "@oclif/core";

import { Effect, Layer } from "effect";

import {
  type ConfigError,
  LandoRuntimeBootstrapError,
  NotImplementedError,
  RendererSelectionError,
} from "@lando/sdk/errors";
import type { EventService, Renderer } from "@lando/sdk/services";

import type { BootstrapLevel } from "../../runtime/bootstrap.ts";
import type { RendererMode } from "../bug-report.ts";
import { newInvocationId } from "../command-lifecycle.ts";
import { normalizeScratchRunArgvForParsing } from "../commands/scratch-run.ts";
import { type ResultFormat, resolveResultFormat, universalFormatFlagDefs } from "../format-flags.ts";
import {
  resolveCliDeprecationWarnings,
  resolveCliRendererMode,
  runWithRendererHandling,
} from "../renderer-boundary.ts";
import type { StreamFrameSink } from "../stream-frame-sink.ts";
import {
  preCommandOutputMode,
  renderCommandFlagValueValidation,
  renderPreCommandFailure,
} from "./command-boundary.ts";
import {
  type LandoCommandSpec,
  formatCommandError,
  isCanonicalLandoCommandId,
  isMvpCommandId,
  notImplementedErrorForCommand,
  validateCommandSpec,
} from "./command-spec.ts";
import { getCommandRuntimeLayer } from "./hooks/init.ts";

export {
  type LandoAliasSpec,
  type LandoCommandNamespace,
  type LandoCommandSpec,
  type LandoTopLevelAlias,
  CommandRegistrationError,
  EmptyResultSchema,
  extractSpecAbortSignal,
  formatCommandError,
  isCanonicalLandoCommandId,
  isMvpCommandId,
  notImplementedErrorForCommand,
  resolveTopLevelAliases,
  validateCommandSpec,
} from "./command-spec.ts";

/**
 * Base class for built-in commands. Plugin-contributed commands compile
 * to subclasses of this via `compileCommandSpec()`.
 */
export abstract class LandoCommandBase extends Command {
  static override baseFlags = universalFormatFlagDefs;

  /**
   * The Lando-specific spec backing this command. Subclasses set this as a
   * static field; the base reads it to drive bootstrap and Effect execution.
   */
  static landoSpec: LandoCommandSpec | undefined = undefined;

  /** Bootstrap depth required before this command can run. */
  static bootstrap: BootstrapLevel | undefined = undefined;

  /**
   * Run the underlying Effect program for this command. Subclasses' `run()`
   * should call this.
   * The init hook owns runtime selection, and the base provides that runtime
   * to the command Effect.
   */
  protected async runEffect<A, E, R>(spec: LandoCommandSpec<A, E, R>): Promise<void> {
    validateCommandSpec(spec);
    if (spec.id === "apps:scratch:run") {
      const normalizedArgv = normalizeScratchRunArgvForParsing(this.argv);
      this.argv.length = 0;
      this.argv.push(...normalizedArgv);
    }

    let rendererMode: RendererMode;
    try {
      const resolution = await resolveCliRendererMode({
        argv: this.argv,
        env: process.env,
      });
      rendererMode = resolution.mode;
      this.argv.length = 0;
      this.argv.push(...resolution.remainingArgv);
    } catch (error) {
      if (error instanceof RendererSelectionError || error instanceof NotImplementedError) {
        await renderPreCommandFailure({
          commandId: "cli:renderer-selection",
          error,
          ...preCommandOutputMode({ argv: this.argv, env: process.env }),
        });
        return;
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
        await renderPreCommandFailure({
          commandId: "cli:format-selection",
          error,
          rendererMode,
          resultFormat: rendererMode === "json" ? "json" : "text",
        });
        return;
      }
      throw error;
    }

    if (
      await renderCommandFlagValueValidation({
        commandId: spec.id,
        argv: this.argv,
        definitions: { ...this.ctor.baseFlags, ...this.ctor.flags },
        rendererMode,
        resultFormat,
        resultSchema: spec.resultSchema,
        deprecationWarnings: deprecationWarnings.enabled,
        allowUnknownFlags: this.ctor.strict === false,
      })
    )
      return;

    if (isCanonicalLandoCommandId(spec.id) && !isMvpCommandId(spec.id)) {
      const error = notImplementedErrorForCommand(spec.id);
      const text = formatCommandError({
        error,
        commandId: spec.id,
        rendererMode,
      });
      if (resultFormat === "json") {
        await runWithRendererHandling(Effect.fail(error), {
          runtime: Layer.empty,
          rendererMode,
          resultFormat,
          command: spec.id,
          resultSchema: spec.resultSchema,
          ...(spec.streaming === undefined ? {} : { streaming: spec.streaming }),
          ...(spec.streamFrames === undefined ? {} : { streamFrames: spec.streamFrames }),
          deprecationWarnings: deprecationWarnings.enabled,
          formatError: (failure) =>
            formatCommandError({
              error: failure,
              commandId: spec.id,
              rendererMode,
            }),
        });
        return;
      }
      throw new Error(text);
    }

    const parsed = await this.parse(this.ctor);

    const runtime = getCommandRuntimeLayer(this.ctor);
    if (runtime === undefined) {
      await renderPreCommandFailure({
        commandId: spec.id,
        error: new LandoRuntimeBootstrapError({
          message: `OCLIF command ${this.id ?? spec.id} is missing a valid static bootstrap declaration.`,
          stage: "minimal",
        }),
        rendererMode,
        resultFormat,
        resultSchema: spec.resultSchema,
        failureExitCode: 1,
        deprecationWarnings: deprecationWarnings.enabled,
      });
      return;
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    const input = {
      argv: this.argv,
      parsedArgv: (parsed as { readonly argv?: ReadonlyArray<string> }).argv ?? [],
      signal: controller.signal,
      flags: (parsed as { flags?: Record<string, unknown> }).flags ?? {},
      args: (parsed as { args?: Record<string, unknown> }).args ?? {},
      rendererMode,
    };
    const flags = input.flags as Record<string, unknown>;
    flags.format = resultFormat;
    if (resultFormat === "json") flags.json = true;
    await runWithRendererHandling(spec.run(input), {
      runtime: runtime as Layer.Layer<
        Exclude<R, EventService | Renderer | StreamFrameSink>,
        ConfigError | LandoRuntimeBootstrapError
      >,
      rendererMode,
      resultFormat,
      command: spec.id,
      invocation: {
        commandId: spec.id,
        argv: input.argv,
        args: input.args,
        flags: input.flags,
        cwd: process.cwd(),
        invocationId: newInvocationId(),
      },
      resultSchema: spec.resultSchema,
      ...(spec.streaming === undefined ? {} : { streaming: spec.streaming }),
      ...(spec.streamingMode === undefined ? {} : { streamingMode: spec.streamingMode }),
      ...(spec.streamFrames === undefined ? {} : { streamFrames: spec.streamFrames }),
      ...(spec.redactionTokens === undefined ? {} : { redactionTokens: spec.redactionTokens }),
      deprecationWarnings: deprecationWarnings.enabled,
      suppressDeprecationDiagnostics: spec.suppressDeprecationDiagnostics?.(input) === true,
      render: (value, ctx) => spec.render?.(value, input, ctx),
      ...(spec.successExitCode === undefined
        ? {}
        : { successExitCode: (value) => spec.successExitCode?.(value, input) }),
      formatError: (error) =>
        formatCommandError({
          error,
          commandId: spec.id,
          rendererMode,
        }),
    }).finally(() => {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    });
  }
}
