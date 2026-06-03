import { Cause, Effect, Exit, Layer, Option } from "effect";

import { Renderer } from "@lando/sdk/services";

import type { RendererMode } from "./renderer-selection.ts";
import { type RendererIO, createStdioRendererIO } from "./renderer/io.ts";
import {
  makeJsonRendererServiceLive,
  makeLandoRendererServiceLive,
  makePlainRendererServiceLive,
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

const requireRenderer = Effect.serviceOption(Renderer).pipe(
  Effect.flatMap((option) =>
    Option.isNone(option)
      ? Effect.dieMessage("Renderer not provided at the CLI command boundary")
      : Effect.succeed(option.value),
  ),
);

export const writeStdout = (chunk: string): Effect.Effect<void> =>
  requireRenderer.pipe(Effect.flatMap((renderer) => renderer.output.stdout(chunk)));

export const writeResultLine = (text: string): Effect.Effect<void> =>
  requireRenderer.pipe(Effect.flatMap((renderer) => renderer.output.stdout(`${text}\n`)));

export const writeDiagnosticLine = (text: string): Effect.Effect<void> =>
  requireRenderer.pipe(Effect.flatMap((renderer) => renderer.output.stderr(`${text}\n`)));

export interface RunWithRendererHandlingOptions<A, R, RE> {
  readonly runtime: Layer.Layer<Exclude<R, Renderer>, RE>;
  readonly rendererMode: RendererMode;
  readonly io?: RendererIO;
  readonly render?: (value: A) => string | undefined;
  readonly formatError: (error: unknown) => string;
}

export const runWithRendererHandling = async <A, E, R, RE>(
  effect: Effect.Effect<A, E, R>,
  options: RunWithRendererHandlingOptions<A, R, RE>,
): Promise<void> => {
  const rendererLayer = makeRendererServiceLiveForMode(options.rendererMode, options.io);
  const commandLayer = Layer.merge(options.runtime, rendererLayer) as Layer.Layer<R, RE>;
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
      process.exitCode = 1;
    });
  });
  await Effect.runPromise(program.pipe(Effect.provide(rendererLayer)));
};
