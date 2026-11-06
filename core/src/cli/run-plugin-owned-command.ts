import { resolveCommandCompletion } from "@lando/sdk/command-result";
import type { DeprecationNotice } from "@lando/sdk/schema";
import { DeprecationService } from "@lando/sdk/services";
import { DateTime, Effect, Layer } from "effect";
import { commandDescriptorNotice } from "./command-catalog";

import type { RendererIO } from "@lando/renderer/io";
import type {
  CommandInputValidationError,
  CommandStdioError,
  ConfigError,
  LandoRuntimeBootstrapError,
} from "@lando/sdk/errors";
import type { ExecutableCommandInput, ExecutableCommandSpec } from "@lando/sdk/plugins";
import { Renderer } from "@lando/sdk/services";

import { cliRuntimeOptions } from "@lando/engine/runtime/cli-options";
import { discoveryCwd } from "@lando/landofile/operation-discovery";
import { makeLandoRuntime } from "../runtime/layer";
import {
  type CommandStdioStdin,
  commandStdioRequest,
  commandStdioRequestError,
  grantCommandStdio,
} from "./command-stdio";
import {
  activeRendererMode,
  activeResultFormat,
  emitJsonListModeIfRequested,
  resetActiveCommandInvocation,
  runCompiledCommand,
  runWithProcessAbortSignal,
  setActiveCommandId,
} from "./compiled-runtime";
import { validateEventCommandInput } from "./event-command-input";
import { type PluginCommandCatalog, createPluginCommandCatalog } from "./plugin-command-catalog";
import { tryPluginCommandHelp } from "./plugin-command-help";
import { pluginOwnedCliFlagError, pluginOwnedCommandInputFromArgv } from "./plugin-owned-command-input";
export { pluginFlagDefinitions } from "./plugin-flag-definitions";
export {
  pluginOwnedCliFlagError,
  pluginOwnedCommandInputFromArgv,
  renderPluginOwnedCommandHelp,
} from "./plugin-owned-command-input";
import { CommandPayloadStdout } from "./command-payload-stdout";
import type { MalformedCliFlagValueError, UnknownCliFlagError } from "./flag-value-validation";
import { withRedactedRenderer } from "./redacted-renderer";
import { rejectUnsupportedResultFormat } from "./result-format-guard";

const PLUGIN_OWNED_COMMAND_ID = /^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)+$/u;

export const isPluginOwnedCommandId = (token: string): boolean => PLUGIN_OWNED_COMMAND_ID.test(token);

export interface RunPluginOwnedCommandOptions {
  readonly io?: RendererIO;
  readonly stdin?: CommandStdioStdin;
  readonly signal?: AbortSignal;
  readonly deprecation?: { readonly id: string; readonly notice: DeprecationNotice };
}

export interface PluginOwnedCommandEffectOptions {
  readonly stdin?: CommandStdioStdin;
  readonly stdoutIsTTY?: boolean;
  readonly stdinIsTTY?: boolean;
  readonly resultFormat?: import("./format-flags").ResultFormat;
  readonly rendererMode?: import("./renderer-selection").RendererMode;
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

const withGrantedStdio = Effect.fnUntraced(function* <A, E, R>(
  spec: Pick<ExecutableCommandSpec<A, E, R>, "id" | "args" | "run">,
  input: ExecutableCommandInput,
  grantOptions: PluginOwnedCommandEffectOptions,
): Effect.fn.Return<A, E | CommandStdioError, R | Renderer> {
  const renderer = yield* Renderer;
  const payloadStdout = yield* Effect.serviceOption(CommandPayloadStdout);
  // Capture base stdout before the redacted wrapper so granted payload bytes stay exact.
  const baseStdout = payloadStdout._tag === "Some" ? payloadStdout.value : renderer.output.stdout;
  const request = commandStdioRequest(spec, input.args);
  const stdio = yield* grantCommandStdio({
    ...grantOptions,
    command: spec.id,
    request,
    baseStdout,
    stdoutIsTTY: grantOptions.stdoutIsTTY === true,
    stdinIsTTY: grantOptions.stdinIsTTY === true,
    resultFormat: grantOptions.resultFormat ?? "text",
    rendererMode: grantOptions.rendererMode ?? "lando",
  });
  const grantedInput: ExecutableCommandInput = stdio === undefined ? input : { ...input, stdio };
  return yield* withRedactedRenderer(spec.run(grantedInput));
});

export const pluginOwnedCommandEffect = <A, E, R>(
  spec: Pick<
    ExecutableCommandSpec<A, E, R>,
    "id" | "flags" | "args" | "strict" | "run" | "render" | "redactionTokens" | "completion"
  >,
  argv: ReadonlyArray<string>,
  renderResult: boolean,
  options: PluginOwnedCommandEffectOptions = {},
): Effect.Effect<
  A,
  E | CommandInputValidationError | MalformedCliFlagValueError | UnknownCliFlagError | CommandStdioError,
  R | Renderer
> => {
  const flagError = pluginOwnedCliFlagError(spec, argv);
  if (flagError !== undefined) return Effect.fail(flagError);
  const parsed = pluginOwnedCommandInputFromArgv(spec, argv);
  return validateEventCommandInput(spec, parsed).pipe(
    Effect.flatMap((input) =>
      withGrantedStdio(spec, input, options).pipe(
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

const renderPluginOwnedPreCommandFailure = async (
  error: unknown,
  io?: RendererIO,
  payloadStdout = false,
): Promise<void> => {
  await runCompiledCommand(Effect.fail(error), Layer.empty, () => undefined, {
    failureExitCode: () => 2,
    preCommand: true,
    payloadStdout,
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
      await import("../runtime/bundled-plugins");
      const parsed = pluginOwnedCommandInputFromArgv(spec, argv);
      const request = commandStdioRequest(spec, parsed.args);
      const flagError = pluginOwnedCliFlagError(spec, argv);
      if (flagError !== undefined) {
        await renderPluginOwnedPreCommandFailure(flagError, options.io, request.stdout === true);
        return;
      }
      const completion = spec.completion;
      const stdinSource = options.stdin ?? process.stdin;
      const stdio = {
        ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
        stdoutIsTTY:
          options.io?.stdoutIsTTY === true || (options.io === undefined && process.stdout.isTTY === true),
        stdinIsTTY: stdinSource.isTTY === true,
        resultFormat: activeResultFormat,
        rendererMode: activeRendererMode,
      };
      if (signal.aborted) return;
      // Derive refusals from argv alone, without invoking plugin parsers before the lifecycle.
      const refusal = commandStdioRequestError({
        command: spec.id,
        request,
        ...stdio,
      });
      if (refusal !== undefined) {
        await renderPluginOwnedPreCommandFailure(refusal, options.io, request.stdout === true);
        return;
      }
      let normalizedInput: ExecutableCommandInput;
      const operation = Effect.gen(function* () {
        normalizedInput = yield* validateEventCommandInput(spec, parsed);
        if (options.deprecation !== undefined) {
          const service = yield* Effect.serviceOption(DeprecationService);
          if (service._tag === "Some")
            yield* service.value.use({
              kind: "command",
              id: options.deprecation.id,
              notice: options.deprecation.notice,
              timestamp: DateTime.nowUnsafe(),
            });
        }
        return yield* withGrantedStdio(spec, normalizedInput, stdio);
      });
      const cwd = await Effect.runPromise(discoveryCwd());
      await runCompiledCommand(operation, defaultPluginRuntime(spec.bootstrap, cwd), () => undefined, {
        ...compiledPluginOptions(spec, options),
        payloadStdout: request.stdout === true,
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
    // Without a loaded spec there is no stdio declaration, so stdout keeps its usual role.
    await renderPluginOwnedPreCommandFailure("unavailable" in row ? row.unavailable : row.loadError);
    return "dispatched";
  }
  if (signal?.aborted) return "dispatched";
  const spec = row.spec;
  if (spec === undefined) return "not-found";
  setActiveCommandId(spec.id);
  resetActiveCommandInvocation(spec.id, argv);
  if (argv.includes("--help") || argv.includes("-h")) {
    await tryPluginCommandHelp(commandId, catalog);
    return "dispatched";
  }
  // A plugin-owned command declares no opt-in format, so it honors exactly the
  // universal set. Refuse before --json key listing can report success.
  const payloadStdout =
    commandStdioRequest(spec, pluginOwnedCommandInputFromArgv(spec, argv).args).stdout === true;
  if (await rejectUnsupportedResultFormat(spec.id, undefined, { payloadStdout })) return "dispatched";
  const flagError = pluginOwnedCliFlagError(spec, argv);
  if (flagError !== undefined) {
    await renderPluginOwnedPreCommandFailure(flagError, undefined, payloadStdout);
    return "dispatched";
  }
  if (await emitJsonListModeIfRequested(spec.resultSchema)) return "dispatched";
  const notice = commandDescriptorNotice(row.descriptor, commandId);
  await runPluginOwnedCommand(spec, argv, {
    ...(signal === undefined ? {} : { signal }),
    ...(notice === undefined ? {} : { deprecation: { id: commandId, notice } }),
  });
  return "dispatched";
};

export const tryPluginOwnedCommand = async (
  token: string,
  argv: ReadonlyArray<string>,
  signal?: AbortSignal,
  catalog: PluginCommandCatalog = createPluginCommandCatalog(signal),
): Promise<boolean> => (await dispatchPluginOwnedCommand(token, argv, signal, catalog)) === "dispatched";
