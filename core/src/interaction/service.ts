/**
 * Default `InteractionServiceLive` — the single prompting chokepoint.
 *
 * Wraps the existing line-based prompt engine (`collectPrompts`) behind the
 * published `InteractionService` Effect interface. `PromptIO` is an internal
 * Live-layer detail here, not the public prompting surface.
 *
 * Renderer-boundary carve-out: this module owns the Live-layer stdin reader
 * and the no-renderer fallback writer. Prompt output
 * routes through `Renderer.output.stdout`/`stderr` whenever a `Renderer` is
 * resolvable via `Effect.serviceOption`; only with no renderer active does it
 * fall back to a direct stdio write (via the reused `createStdioPromptIO`).
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Cause, type Context, Effect, Layer, Option, Redacted } from "effect";

import {
  ChoicesUnavailableError,
  InteractionCancelledError,
  InteractionRequiredError,
  InteractionUnavailableError,
  PromptValidationError,
  RecipeChoicesError,
  RecipeMissingAnswerError,
  RecipePromptValidationError,
  RecipeRunNotAllowedError,
} from "@lando/sdk/errors";
import type {
  PromptBatchOptions,
  PromptChoice,
  PromptMode,
  PromptSpec,
  RecipePrompt,
  PromptAnswer as SdkPromptAnswer,
} from "@lando/sdk/schema";
import {
  type ConfirmSpec,
  type InteractionError,
  InteractionService,
  type InteractionServiceShape,
  type PromptAnswers,
  Renderer,
  type SecretSpec,
  type SelectSpec,
} from "@lando/sdk/services";

import {
  type ChoicesCommandRunner,
  type CollectPromptsOptions,
  type PromptAnswers as EnginePromptAnswers,
  PromptCancelledError,
  type PromptDriver,
  type PromptIO,
  type PromptLineReader,
  collectPrompts,
  createLineReader,
  createStdioPromptIO,
} from "../recipes/prompts/index.ts";
import { type InteractiveDriverGate, resolveInteractivePromptDriver } from "./interactive-driver.ts";
import { getInteractionServiceOverride } from "./testing-override.ts";

const STDIO_INTERACTION_ID = "stdio";

type RendererService = Context.Tag.Service<typeof Renderer>;

/** Driver-resolution seam: render rich (e.g. OpenTUI) controls when interactive on a TTY. */
export type ResolveInteractionDriver = (gate: {
  readonly isTTY: boolean;
  readonly yes: boolean;
  readonly nonInteractive: boolean;
}) => Promise<PromptDriver | undefined>;

/** Adapts the OpenTUI prompt-driver loader to the {@link ResolveInteractionDriver} seam; overrides are test-only. */
export const makeDefaultResolveInteractionDriver = (
  overrides: Pick<InteractiveDriverGate, "env" | "importRendererPlugin"> = {},
): ResolveInteractionDriver => {
  return (gate) =>
    resolveInteractivePromptDriver({
      isTTY: gate.isTTY,
      yes: gate.yes,
      nonInteractive: gate.nonInteractive,
      ...(overrides.env === undefined ? {} : { env: overrides.env }),
      ...(overrides.importRendererPlugin === undefined
        ? {}
        : { importRendererPlugin: overrides.importRendererPlugin }),
    });
};

/** Construction inputs; all optional so tests can script stdin/stdout and inject a driver. */
export interface InteractionServiceDeps {
  readonly stdin?: NodeJS.ReadableStream;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  readonly choicesRunner?: ChoicesCommandRunner;
  readonly resolveDriver?: ResolveInteractionDriver;
  readonly id?: string;
  readonly defaultMode?: PromptMode;
}

type InternalPromptBatchOptions = PromptBatchOptions & {
  readonly choicesRunner?: ChoicesCommandRunner;
};

const isTtyStdin = (stdin: NodeJS.ReadableStream): boolean =>
  (stdin as Partial<Pick<RawCapableTty, "isTTY">>).isTTY === true;

interface RawCapableTty {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  readonly setRawMode: (mode: boolean) => void;
}

const asRawTty = (stdin: NodeJS.ReadableStream): RawCapableTty | undefined => {
  const candidate = stdin as Partial<RawCapableTty>;
  return typeof candidate.setRawMode === "function" ? (stdin as unknown as RawCapableTty) : undefined;
};

const readRawMode = (stdin: NodeJS.ReadableStream): boolean | undefined => asRawTty(stdin)?.isRaw;

const restoreTty = (stdin: NodeJS.ReadableStream, rawModeBefore: boolean | undefined): void => {
  const tty = asRawTty(stdin);
  if (tty !== undefined && tty.isTTY === true && rawModeBefore !== undefined && tty.isRaw !== rawModeBefore) {
    tty.setRawMode(rawModeBefore);
  }
};

const isCancellation = (cause: unknown): boolean =>
  cause instanceof PromptCancelledError || (cause instanceof Error && cause.name === "PromptCancelledError");

const describeCause = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const mapInteractionError = (cause: unknown, serviceId: string): InteractionError => {
  if (cause instanceof RecipeMissingAnswerError) {
    return new InteractionRequiredError({
      message: cause.message,
      promptName: cause.promptName,
      remediation: cause.remediation,
    });
  }
  if (cause instanceof RecipePromptValidationError) {
    return new PromptValidationError({
      message: cause.message,
      promptName: cause.promptName,
      promptType: cause.promptType,
      issue: cause.issue,
      remediation: cause.remediation,
    });
  }
  if (cause instanceof RecipeChoicesError) {
    return new ChoicesUnavailableError({
      message: cause.message,
      promptName: cause.promptName,
      command: cause.command,
      kind: cause.kind,
      remediation: cause.remediation,
      ...(cause.exitCode === undefined ? {} : { exitCode: cause.exitCode }),
    });
  }
  if (cause instanceof RecipeRunNotAllowedError) {
    return new ChoicesUnavailableError({
      message: cause.message,
      promptName: cause.commandId,
      command: cause.commandId,
      kind: "command-failed",
      remediation: cause.remediation,
    });
  }
  if (isCancellation(cause)) {
    return new InteractionCancelledError({
      message: cause instanceof Error ? cause.message : "Prompt cancelled.",
      remediation: "Provide answers via --answer/--answers/--yes, or re-run interactively.",
    });
  }
  return new InteractionUnavailableError({
    message: `Interaction failed: ${describeCause(cause)}`,
    serviceId,
    remediation: "Provide answers non-interactively via --answer/--answers/--yes.",
  });
};

const interruptedCancellation = (): InteractionCancelledError =>
  new InteractionCancelledError({
    message: "Prompt interrupted.",
    remediation: "Re-run and provide answers via --answer/--answers/--yes, or run interactively.",
  });

const resolveGate = (
  options: PromptBatchOptions | undefined,
  isTty: boolean,
  defaultMode: PromptMode,
): { readonly yes: boolean; readonly nonInteractive: boolean; readonly interactive: boolean } => {
  const yes = options?.yes === true;
  let interactive: boolean;
  if (options?.interactive === true) interactive = true;
  else if (options?.interactive === false) interactive = false;
  else {
    const mode = options?.mode ?? defaultMode;
    interactive = mode === "interactive" ? true : mode === "non-interactive" ? false : isTty;
  }
  return { yes, nonInteractive: !interactive, interactive };
};

const readAnswersFileJson = async (path: string): Promise<Record<string, string>> => {
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`answers file "${path}" must contain a JSON object`);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string") throw new Error(`answer "${key}" in "${path}" must be a string`);
    out[key] = value;
  }
  return out;
};

export const makeInteractionService = (deps: InteractionServiceDeps = {}): InteractionServiceShape => {
  const stdin = deps.stdin ?? process.stdin;
  const id = deps.id ?? STDIO_INTERACTION_ID;
  const defaultMode: PromptMode = deps.defaultMode ?? "auto";
  // One reader per service instance: buffered-ahead stdin survives across batches.
  const lineReader: PromptLineReader = createLineReader(stdin);
  // Serialize batches: the shared reader and its buffer are mutable single-stream state.
  const promptLock = Effect.unsafeMakeSemaphore(1);

  const buildIo = (rendererOption: Option.Option<RendererService>, signal: AbortSignal): PromptIO => {
    const base = createStdioPromptIO({
      stdin,
      lineReader,
      ...(deps.stdout === undefined ? {} : { stdout: deps.stdout }),
      ...(deps.stderr === undefined ? {} : { stderr: deps.stderr }),
      signal,
    });
    if (Option.isNone(rendererOption)) return base;
    const renderer = rendererOption.value;
    return {
      isTTY: base.isTTY,
      readLine: base.readLine,
      write: (chunk) => {
        Effect.runSync(renderer.output.stdout(chunk));
      },
      writeError: (chunk) => {
        Effect.runSync(renderer.output.stderr(chunk));
      },
    };
  };

  const runEngine = (
    collect: Omit<CollectPromptsOptions, "io">,
    rendererOption: Option.Option<RendererService>,
  ): Effect.Effect<EnginePromptAnswers, InteractionError> =>
    Effect.uninterruptibleMask((restore) =>
      restore(
        Effect.async<EnginePromptAnswers, InteractionError>((resume, signal) => {
          const rawModeBefore = readRawMode(stdin);
          const io = buildIo(rendererOption, signal);
          let settled = false;
          collectPrompts({ ...collect, io }).then(
            (answers) => {
              settled = true;
              resume(Effect.succeed(answers));
            },
            (cause) => {
              settled = true;
              resume(Effect.fail(mapInteractionError(cause, id)));
            },
          );
          return Effect.sync(() => {
            if (!settled) restoreTty(stdin, rawModeBefore);
          });
        }),
      ).pipe(
        Effect.catchAllCause((cause) =>
          Cause.isInterruptedOnly(cause) ? Effect.fail(interruptedCancellation()) : Effect.failCause(cause),
        ),
      ),
    );

  const resolveDriver = (
    interactive: boolean,
    tty: boolean,
    gate: { readonly yes: boolean; readonly nonInteractive: boolean },
  ): Effect.Effect<PromptDriver | undefined> =>
    deps.resolveDriver === undefined || !interactive || !tty
      ? Effect.succeed(undefined)
      : Effect.promise(() =>
          (deps.resolveDriver as ResolveInteractionDriver)({
            isTTY: tty,
            yes: gate.yes,
            nonInteractive: gate.nonInteractive,
          }),
        );

  const runBatch = (
    specs: ReadonlyArray<PromptSpec>,
    options: PromptBatchOptions | undefined,
  ): Effect.Effect<EnginePromptAnswers, InteractionError> =>
    Effect.gen(function* () {
      const rendererOption = yield* Effect.serviceOption(Renderer);
      const tty = isTtyStdin(stdin);
      const gate = resolveGate(options, tty, defaultMode);
      const cwd = options?.cwd ?? process.cwd();
      const explicit = options?.answers ?? {};
      const answersFilePath =
        options?.answersFile === undefined ? undefined : resolve(cwd, options.answersFile);
      const choicesRunner =
        (options as InternalPromptBatchOptions | undefined)?.choicesRunner ?? deps.choicesRunner;
      const fromFile =
        answersFilePath === undefined
          ? {}
          : yield* Effect.tryPromise({
              try: () => readAnswersFileJson(answersFilePath),
              catch: (cause) =>
                new PromptValidationError({
                  message: `Could not load answers file: ${describeCause(cause)}`,
                  promptName: "(answers file)",
                  promptType: "text",
                  issue: describeCause(cause),
                  remediation: "Pass a readable JSON object of string answers via --answers <file>.",
                }),
            });
      const answers: Record<string, string> = { ...fromFile, ...explicit };
      const driver = yield* resolveDriver(gate.interactive, tty, gate);
      const collect: Omit<CollectPromptsOptions, "io"> = {
        prompts: specs as ReadonlyArray<RecipePrompt>,
        answers,
        yes: gate.yes,
        nonInteractive: gate.nonInteractive,
        cwd,
        ...(options?.runs === undefined ? {} : { runs: options.runs }),
        ...(choicesRunner === undefined ? {} : { choicesRunner }),
        ...(driver === undefined ? {} : { interactiveDriver: driver }),
      };
      return yield* promptLock.withPermits(1)(runEngine(collect, rendererOption));
    });

  const promptAll = (
    specs: ReadonlyArray<PromptSpec>,
    options?: PromptBatchOptions,
  ): Effect.Effect<PromptAnswers, InteractionError> => runBatch(specs, options);

  const prompt = (spec: PromptSpec): Effect.Effect<SdkPromptAnswer, InteractionError> =>
    runBatch([spec], undefined).pipe(Effect.map((answers) => answers[spec.name] as SdkPromptAnswer));

  const confirm = (spec: ConfirmSpec): Effect.Effect<boolean, InteractionError> => {
    const name = spec.name ?? "confirm";
    const promptSpec: PromptSpec = {
      name,
      type: "confirm",
      message: spec.message,
      ...(spec.default === undefined ? {} : { default: spec.default }),
    };
    return runBatch([promptSpec], spec).pipe(Effect.map((answers) => answers[name] === true));
  };

  const select = <A extends string | number | boolean>(
    spec: SelectSpec<A>,
  ): Effect.Effect<A, InteractionError> => {
    const name = spec.name ?? "select";
    const promptSpec: PromptSpec = {
      name,
      type: "select",
      message: spec.message,
      choices: spec.choices as ReadonlyArray<PromptChoice>,
      ...(spec.default === undefined ? {} : { default: spec.default }),
    };
    return runBatch([promptSpec], spec).pipe(Effect.map((answers) => answers[name] as A));
  };

  const secret = (spec: SecretSpec): Effect.Effect<Redacted.Redacted<string>, InteractionError> => {
    const name = spec.name ?? "secret";
    const promptSpec: PromptSpec = { name, type: "secret", message: spec.message };
    return runBatch([promptSpec], spec).pipe(
      Effect.map((answers) => {
        const value = answers[name];
        return Redacted.make(typeof value === "string" ? value : String(value));
      }),
    );
  };

  return {
    id,
    isInteractive: Effect.sync(() => isTtyStdin(stdin)),
    prompt,
    promptAll,
    confirm,
    select,
    secret,
  };
};

export const InteractionServiceLive: Layer.Layer<InteractionService> = Layer.suspend(() =>
  Layer.succeed(
    InteractionService,
    getInteractionServiceOverride() ??
      makeInteractionService({ resolveDriver: makeDefaultResolveInteractionDriver() }),
  ),
);
