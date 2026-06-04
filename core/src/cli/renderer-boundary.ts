import { Cause, Effect, Exit, Layer, Option } from "effect";

import { ConfigService, type EventService, Renderer } from "@lando/sdk/services";

import { ConfigServiceLive } from "../services/config.ts";
import { EventServiceLive } from "../services/event-service.ts";
import {
  type RendererMode,
  type ResolveRendererModeResult,
  resolveRendererMode,
} from "./renderer-selection.ts";
import { type RendererIO, createStdioRendererIO } from "./renderer/io.ts";
import {
  makeJsonRendererLive,
  makeJsonRendererServiceLive,
  makeLandoRendererLive,
  makeLandoRendererServiceLive,
  makePlainRendererLive,
  makePlainRendererServiceLive,
  makeVerboseRendererLive,
  makeVerboseRendererServiceLive,
} from "./renderer/runtime.ts";

export const makeRendererServiceLiveForMode = (
  mode: RendererMode,
  io: RendererIO = createStdioRendererIO(),
): Layer.Layer<Renderer> => {
  switch (mode) {
    case "json":
      return makeJsonRendererServiceLive(io);
    case "plain":
      return makePlainRendererServiceLive(io);
    case "verbose":
      return makeVerboseRendererServiceLive(io);
    case "lando":
      return makeLandoRendererServiceLive(io);
  }
};

export const makeRendererEventConsumerLiveForMode = (
  mode: RendererMode,
  io: RendererIO = createStdioRendererIO(),
): Layer.Layer<never, never, EventService> => {
  switch (mode) {
    case "json":
      return makeJsonRendererLive(io);
    case "plain":
      return makePlainRendererLive(io);
    case "verbose":
      return makeVerboseRendererLive(io);
    case "lando":
      return makeLandoRendererLive(io);
  }
};

const requireRenderer = Effect.serviceOption(Renderer).pipe(
  Effect.flatMap((option) =>
    Option.isNone(option)
      ? Effect.dieMessage("Renderer not provided at the CLI command boundary")
      : Effect.succeed(option.value),
  ),
);

export const writeStdout = (chunk: string): Effect.Effect<void> =>
  requireRenderer.pipe(Effect.flatMap((renderer) => renderer.output.stdout(chunk)));

const optionalRenderer = Effect.serviceOption(Renderer);

export const emitOptionalStdout = (chunk: string): Effect.Effect<void> =>
  optionalRenderer.pipe(
    Effect.flatMap((option) => (Option.isSome(option) ? option.value.output.stdout(chunk) : Effect.void)),
  );

export const emitOptionalStderr = (chunk: string): Effect.Effect<void> =>
  optionalRenderer.pipe(
    Effect.flatMap((option) => (Option.isSome(option) ? option.value.output.stderr(chunk) : Effect.void)),
  );

export const writeResultLine = (text: string): Effect.Effect<void> =>
  requireRenderer.pipe(Effect.flatMap((renderer) => renderer.output.stdout(`${text}\n`)));

export const writeDiagnosticLine = (text: string): Effect.Effect<void> =>
  requireRenderer.pipe(Effect.flatMap((renderer) => renderer.output.stderr(`${text}\n`)));

export interface RunWithRendererHandlingOptions<A, R, RE> {
  readonly runtime: Layer.Layer<Exclude<R, Renderer>, RE>;
  readonly rendererMode: RendererMode;
  readonly io?: RendererIO;
  readonly renderEvents?: boolean;
  readonly render?: (value: A) => string | undefined;
  readonly formatError: (error: unknown) => string;
  readonly setExitCode?: (code: number) => void;
}

export const runWithRendererHandling = async <A, E, R, RE>(
  effect: Effect.Effect<A, E, R>,
  options: RunWithRendererHandlingOptions<A, R, RE>,
): Promise<void> => {
  const rendererLayer = makeRendererServiceLiveForMode(options.rendererMode, options.io);
  const commandLayer = (
    options.renderEvents === true
      ? Layer.mergeAll(
          options.runtime,
          Layer.provideMerge(
            makeRendererEventConsumerLiveForMode(options.rendererMode, options.io),
            EventServiceLive,
          ),
          rendererLayer,
        )
      : Layer.merge(options.runtime, rendererLayer)
  ) as Layer.Layer<R, RE>;
  const program = Effect.gen(function* () {
    const exit = yield* Effect.exit(effect.pipe(Effect.provide(commandLayer)));
    if (Exit.isSuccess(exit)) {
      const rendered = options.render?.(exit.value);
      if (rendered !== undefined && rendered.length > 0) yield* writeResultLine(rendered);
      return;
    }
    const failure = Cause.failureOption(exit.cause);
    const message = failure._tag === "Some" ? options.formatError(failure.value) : Cause.pretty(exit.cause);
    yield* writeDiagnosticLine(message);
    yield* Effect.sync(() => {
      (
        options.setExitCode ??
        ((code) => {
          process.exitCode = code;
        })
      )(1);
    });
  });
  await Effect.runPromise(program.pipe(Effect.provide(rendererLayer)));
};

export const readConfigRendererValue = async (): Promise<string | undefined> => {
  const value = await Effect.runPromise(
    Effect.flatMap(ConfigService, (config) => config.load).pipe(
      Effect.map((config) => config.renderer),
      Effect.provide(ConfigServiceLive),
      Effect.catchAll(() => Effect.succeed(undefined)),
    ),
  );
  return typeof value === "string" ? value : undefined;
};

export interface ResolveCliRendererModeOptions {
  readonly argv: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly loadConfigRenderer?: () => Promise<string | undefined>;
}

export const resolveCliRendererMode = async (
  options: ResolveCliRendererModeOptions,
): Promise<ResolveRendererModeResult> => {
  const initial = resolveRendererMode({ argv: options.argv, env: options.env });
  if (initial.source === "flag" || initial.source === "env") return initial;
  const configValue = await (options.loadConfigRenderer ?? readConfigRendererValue)();
  if (configValue !== undefined && configValue !== "") {
    return resolveRendererMode({ argv: options.argv, env: options.env, configValue });
  }
  return initial;
};
