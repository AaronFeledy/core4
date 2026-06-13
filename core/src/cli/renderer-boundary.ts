import { Cause, Effect, Exit, Layer, Option } from "effect";

import type { DeprecationUse } from "@lando/sdk/schema";
import { ConfigService, DeprecationService, type EventService, Renderer } from "@lando/sdk/services";

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
  makePlainTaskDetailRendererLive,
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

export interface RendererEventConsumerOptions {
  readonly plainTaskEvents?: "detail-only";
}

export const makeRendererEventConsumerLiveForMode = (
  mode: RendererMode,
  io: RendererIO = createStdioRendererIO(),
  options: RendererEventConsumerOptions = {},
): Layer.Layer<never, never, EventService> => {
  switch (mode) {
    case "json":
      return makeJsonRendererLive(io);
    case "plain":
      return options.plainTaskEvents === "detail-only"
        ? makePlainTaskDetailRendererLive(io)
        : makePlainRendererLive(io);
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
  readonly plainTaskEvents?: "detail-only";
  readonly deprecationWarnings?: boolean;
  readonly render?: (value: A) => string | undefined;
  readonly formatError: (error: unknown) => string;
  readonly setExitCode?: (code: number) => void;
}

export interface ResolveCliDeprecationWarningsOptions {
  readonly argv: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface ResolveCliDeprecationWarningsResult {
  readonly enabled: boolean;
  readonly remainingArgv: ReadonlyArray<string>;
}

const NO_DEPRECATION_WARNINGS_FLAG = "--no-deprecation-warnings";

export const resolveCliDeprecationWarnings = (
  options: ResolveCliDeprecationWarningsOptions,
): ResolveCliDeprecationWarningsResult => {
  let disabledByFlag = false;
  let afterDoubleDash = false;
  const remainingArgv: string[] = [];
  for (const arg of options.argv) {
    if (afterDoubleDash) {
      remainingArgv.push(arg);
      continue;
    }
    if (arg === "--") {
      afterDoubleDash = true;
      remainingArgv.push(arg);
      continue;
    }
    if (arg === NO_DEPRECATION_WARNINGS_FLAG) {
      disabledByFlag = true;
      continue;
    }
    remainingArgv.push(arg);
  }
  return {
    enabled: !disabledByFlag && options.env.LANDO_DEPRECATION_WARNINGS !== "0",
    remainingArgv,
  };
};

const useCountText = (count: number): string => (count === 1 ? "once" : `${count} times`);

const surfaceLabel = (use: DeprecationUse): string => `${use.kind} ${use.id}`;

const warningText = (entry: DeprecationUse & { readonly count: number }): string => {
  const replacement =
    entry.notice.replacement === undefined ? "" : ` Replacement: ${entry.notice.replacement}.`;
  return `Deprecated ${surfaceLabel(entry)} (used ${useCountText(entry.count)}): ${entry.notice.note}${replacement}`;
};

const infoSummaryText = (entries: ReadonlyArray<DeprecationUse & { readonly count: number }>): string => {
  const surfaces = entries.map(
    (entry) => `${surfaceLabel(entry)} (${entry.count} ${entry.count === 1 ? "use" : "uses"})`,
  );
  return `Deprecated surfaces used: ${surfaces.join(", ")}.`;
};

const jsonDeprecationEventLine = (entry: DeprecationUse & { readonly count: number }): string => {
  const { count: _count, ...use } = entry;
  return JSON.stringify({ _tag: "deprecation-used", use });
};

type DeprecationServiceShape = typeof DeprecationService.Service;

const optionalDeprecationService = Effect.serviceOption(DeprecationService) as Effect.Effect<
  Option.Option<DeprecationServiceShape>,
  never,
  never
>;

const renderDeprecationDiagnostics = (enabled: boolean): Effect.Effect<void, never, Renderer> =>
  Effect.gen(function* () {
    const deprecations = yield* optionalDeprecationService;
    if (Option.isNone(deprecations)) return;
    const renderer = yield* Renderer;
    const summary = yield* deprecations.value.summary();
    if (summary.length === 0) return;

    if (renderer.id === "json") {
      for (const entry of summary) {
        yield* renderer.output.stderr(`${jsonDeprecationEventLine(entry)}\n`);
      }
      return;
    }

    if (!enabled) return;

    for (const entry of summary) {
      if (entry.notice.severity === "warn") {
        yield* renderer.message.warn(warningText(entry)).pipe(Effect.catchAll(() => Effect.void));
      }
    }

    const infoEntries = summary.filter((entry) => entry.notice.severity === "info");
    if (infoEntries.length > 0) {
      yield* renderer.message.info(infoSummaryText(infoEntries)).pipe(Effect.catchAll(() => Effect.void));
    }
  });

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
            makeRendererEventConsumerLiveForMode(options.rendererMode, options.io, {
              ...(options.plainTaskEvents === undefined ? {} : { plainTaskEvents: options.plainTaskEvents }),
            }),
            EventServiceLive,
          ),
          rendererLayer,
        )
      : Layer.merge(options.runtime, rendererLayer)
  ) as Layer.Layer<R, RE>;
  const program = Effect.gen(function* () {
    const renderFailure = (cause: Cause.Cause<unknown>) =>
      Effect.gen(function* () {
        const failure = Cause.failureOption(cause);
        const message = failure._tag === "Some" ? options.formatError(failure.value) : Cause.pretty(cause);
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
    const providedExit = yield* Effect.exit(
      Effect.gen(function* () {
        const commandExit = yield* Effect.exit(effect);
        yield* renderDeprecationDiagnostics(options.deprecationWarnings ?? true);
        return commandExit;
      }).pipe(Effect.provide(commandLayer)),
    );
    if (Exit.isFailure(providedExit)) {
      yield* renderFailure(providedExit.cause);
      return;
    }
    const exit = providedExit.value;
    if (Exit.isSuccess(exit)) {
      const rendered = options.render?.(exit.value);
      if (rendered !== undefined && rendered.length > 0) yield* writeResultLine(rendered);
      return;
    }
    yield* renderFailure(exit.cause);
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
