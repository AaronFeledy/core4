import { resolveCommandCompletion } from "@lando/sdk/command-result";
import { Effect, Layer } from "effect";

import type { RendererIO } from "@lando/renderer/io";
import type { CommandInputValidationError, ConfigError, LandoRuntimeBootstrapError } from "@lando/sdk/errors";
import type { ExecutableCommandSpec } from "@lando/sdk/plugins";
import type { Renderer } from "@lando/sdk/services";

import { cliRuntimeOptions } from "@lando/engine/runtime/cli-options";
import { discoveryCwd } from "@lando/landofile/operation-discovery";
import { makeLandoRuntime } from "../runtime/layer";
import {
  emitJsonListModeIfRequested,
  runCompiledCommand,
  runWithProcessAbortSignal,
} from "./compiled-runtime";
import { validateEventCommandInput } from "./event-command-input";
import { type PluginCommandCatalog, createPluginCommandCatalog } from "./plugin-command-catalog";
import { tryPluginCommandHelp } from "./plugin-command-help";
import { pluginOwnedCliFlagError, pluginOwnedCommandInputFromArgv } from "./plugin-owned-command-input";
export {
  pluginFlagDefinitions,
  pluginOwnedCliFlagError,
  pluginOwnedCommandInputFromArgv,
  renderPluginOwnedCommandHelp,
} from "./plugin-owned-command-input";
import type { MalformedCliFlagValueError, UnknownCliFlagError } from "./flag-value-validation";
import { withRedactedRenderer } from "./redacted-renderer";
import { rejectUnsupportedResultFormat } from "./result-format-guard";

const PLUGIN_OWNED_COMMAND_ID = /^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)+$/u;

export const isPluginOwnedCommandId = (token: string): boolean => PLUGIN_OWNED_COMMAND_ID.test(token);

export interface RunPluginOwnedCommandOptions {
  readonly io?: RendererIO;
  readonly signal?: AbortSignal;
}

type PluginOwnedRuntime = Layer.Layer<unknown, ConfigError | LandoRuntimeBootstrapError>;

const defaultPluginRuntime = (
  bootstrap: ExecutableCommandSpec["bootstrap"],
  cwd: string,
): PluginOwnedRuntime =>
  makeLandoRuntime(
    cliRuntimeOptions({ bootstrap, cwd, plugins: { policy: "discovery" } }),
  ) as PluginOwnedRuntime;

const compiledPluginOptions = (spec: ExecutableCommandSpec, options: RunPluginOwnedCommandOptions) => ({
  resultSchema: spec.resultSchema,
  ...(options.io === undefined ? {} : { io: options.io }),
  ...(spec.redactionTokens === undefined
    ? {}
    : { redactionTokens: (result: unknown) => spec.redactionTokens?.(result) ?? [] }),
});

export const pluginOwnedCommandEffect = <A, E, R>(
  spec: Pick<
    ExecutableCommandSpec<A, E, R>,
    "id" | "flags" | "args" | "strict" | "run" | "render" | "redactionTokens" | "completion"
  >,
  argv: ReadonlyArray<string>,
  renderResult: boolean,
): Effect.Effect<
  A,
  E | CommandInputValidationError | MalformedCliFlagValueError | UnknownCliFlagError,
  R | Renderer
> => {
  const flagError = pluginOwnedCliFlagError(spec, argv);
  if (flagError !== undefined) return Effect.fail(flagError);
  const parsed = pluginOwnedCommandInputFromArgv(spec, argv);
  return validateEventCommandInput(spec, parsed).pipe(
    Effect.flatMap((input) =>
      withRedactedRenderer(spec.run(input)).pipe(
        Effect.tap((result) => {
          if (!renderResult || spec.render === undefined) return Effect.void;
          const render = spec.render;
          const completion = spec.completion;
          return withRedactedRenderer(
            render({
              input,
              result,
              stdout: "",
              stderr: "",
              exitCode: resolveCommandCompletion(
                spec.id,
                result,
                completion === undefined ? undefined : (value) => completion(value, input),
              ).exitCode,
            }),
            { redactionTokens: spec.redactionTokens?.(result) ?? [] },
          );
        }),
      ),
    ),
  );
};

const renderPluginOwnedPreCommandFailure = async (error: unknown, io?: RendererIO): Promise<void> => {
  await runCompiledCommand(Effect.fail(error), Layer.empty, () => undefined, {
    failureExitCode: () => 2,
    preCommand: true,
    ...(io === undefined ? {} : { io }),
  });
};

const runPluginOwnedCommand = (
  spec: ExecutableCommandSpec,
  argv: ReadonlyArray<string>,
  options: RunPluginOwnedCommandOptions = {},
): Promise<void> =>
  runWithProcessAbortSignal(
    async (signal) => {
      const flagError = pluginOwnedCliFlagError(spec, argv);
      if (flagError !== undefined) {
        await renderPluginOwnedPreCommandFailure(flagError, options.io);
        return;
      }
      const parsed = pluginOwnedCommandInputFromArgv(spec, argv);
      const completion = spec.completion;
      let normalizedInput: import("@lando/sdk/plugins").ExecutableCommandInput;
      const operation = validateEventCommandInput(spec, parsed).pipe(
        Effect.flatMap((input) => {
          normalizedInput = input;
          return withRedactedRenderer(spec.run(input));
        }),
      );
      const cwd = await Effect.runPromise(discoveryCwd());
      await runCompiledCommand(operation, defaultPluginRuntime(spec.bootstrap, cwd), () => undefined, {
        ...compiledPluginOptions(spec, options),
        signal,
        ...(completion === undefined
          ? {}
          : { completion: (value: unknown) => completion(value, normalizedInput) }),
        renderEffect: (completed) =>
          spec.render === undefined
            ? Effect.void
            : withRedactedRenderer(
                spec.render({
                  input: normalizedInput,
                  result: completed.value,
                  stdout: "",
                  stderr: "",
                  exitCode: completed.exitCode,
                }),
                { redactionTokens: spec.redactionTokens?.(completed.value) ?? [] },
              ),
      });
    },
    options.signal === undefined ? {} : { signal: options.signal },
  );

const dispatchPluginOwnedCommand = async (
  commandId: string,
  argv: ReadonlyArray<string>,
  signal?: AbortSignal,
  catalog: PluginCommandCatalog = createPluginCommandCatalog(signal),
): Promise<"dispatched" | "not-found"> => {
  if (signal?.aborted) return "dispatched";
  const row = await catalog.resolve(commandId);
  if (row === undefined) return "not-found";
  if ("unavailable" in row || row.loadError !== undefined) {
    await renderPluginOwnedPreCommandFailure("unavailable" in row ? row.unavailable : row.loadError);
    return "dispatched";
  }
  if (signal?.aborted) return "dispatched";
  const spec = row.spec;
  if (spec === undefined) return "not-found";
  if (argv.includes("--help") || argv.includes("-h")) {
    await tryPluginCommandHelp(commandId, catalog);
    return "dispatched";
  }
  // A plugin-owned command declares no opt-in format, so it honors exactly the
  // universal set. Refuse before --json key listing can report success.
  if (await rejectUnsupportedResultFormat(spec.id, undefined)) return "dispatched";
  const flagError = pluginOwnedCliFlagError(spec, argv);
  if (flagError !== undefined) {
    await renderPluginOwnedPreCommandFailure(flagError);
    return "dispatched";
  }
  if (await emitJsonListModeIfRequested(spec.resultSchema)) return "dispatched";
  await runPluginOwnedCommand(spec, argv, signal === undefined ? {} : { signal });
  return "dispatched";
};

export const tryPluginOwnedCommand = async (
  token: string,
  argv: ReadonlyArray<string>,
  signal?: AbortSignal,
  catalog: PluginCommandCatalog = createPluginCommandCatalog(signal),
): Promise<boolean> =>
  isPluginOwnedCommandId(token) &&
  (await dispatchPluginOwnedCommand(token, argv, signal, catalog)) === "dispatched";
