/**
 * The one terminal document of a command run and the committer that writes it.
 *
 * Every path that ends a run (a completed or failed command, a `--jq`
 * replacement, the fallback for a failure outside the run) plans a
 * `TerminalDocument` and hands it to the run's single committer. The committer
 * is the only code that writes that document or sets the run's exit status, and
 * it does both at most once.
 */

import { Renderer } from "@lando/sdk/services";
import { Cause, Effect, Exit } from "effect";
import { commandInterruptionExitCode } from "./command-interruption";
import { interruptOnAbort } from "./interrupt-on-abort";

/**
 * One write of the document, in order. `stdout` and `stderr` chunks are written
 * byte for byte, so a captured render keeps its exact bytes and interleaving;
 * a `warning` goes through the renderer's warning message.
 */
export type TerminalWrite =
  | { readonly channel: "stdout"; readonly text: string | Uint8Array }
  | { readonly channel: "stderr"; readonly text: string | Uint8Array }
  | { readonly channel: "warning"; readonly text: string };

/** Everything a run writes once its runtime has closed. */
export interface TerminalDocument {
  readonly writes: ReadonlyArray<TerminalWrite>;
  readonly exitCode: number;
}

export const resultLine = (text: string): TerminalWrite => ({ channel: "stdout", text: `${text}\n` });
export const diagnosticLine = (text: string): TerminalWrite => ({ channel: "stderr", text: `${text}\n` });
export const warningMessage = (text: string): TerminalWrite => ({ channel: "warning", text });

const writeEntry = (renderer: Renderer["Service"], entry: TerminalWrite): Effect.Effect<void> => {
  switch (entry.channel) {
    case "stdout":
      return renderer.output.stdout(entry.text);
    case "stderr":
      return renderer.output.stderr(entry.text);
    case "warning":
      return Effect.orDie(renderer.message.warn(entry.text));
    default:
      return entry satisfies never;
  }
};

export interface TerminalCommitter {
  /** Writes the document and sets its exit status on the first call; every later call does nothing. */
  readonly commit: (document: TerminalDocument) => Effect.Effect<void, never, Renderer>;
  /** True once a document was handed to `commit`, whether or not it was fully written. */
  readonly attempted: () => boolean;
}

export interface TerminalCommitterOptions {
  readonly signal?: AbortSignal | undefined;
  readonly setExitCode?: ((code: number) => void) | undefined;
  /** A broken stdio pipe leaves the status to the process broken-pipe policy (exit 141). */
  readonly brokenPipe: () => boolean;
  /** Records a write that failed partway in the debug channel. */
  readonly recordDefect: (cause: Cause.Cause<unknown>) => Effect.Effect<void>;
}

/**
 * The run's single committer. A write that fails partway, or one the abort
 * signal abandons, stops the document and sets a failure status instead of the
 * document's own: the interruption code for an abandoned or interrupted write,
 * otherwise 1. A broken pipe sets no status, so the process exits 141 silently.
 */
export const makeTerminalCommitter = (options: TerminalCommitterOptions): TerminalCommitter => {
  let attempted = false;
  let statusSet = false;
  const setStatus = (code: number): void => {
    if (statusSet) return;
    statusSet = true;
    if (options.setExitCode === undefined) process.exitCode = code;
    else options.setExitCode(code);
  };
  const { signal } = options;
  // A blocked write is abandoned when the run is cancelled, so a stuck reader never hangs the exit.
  const written = (write: Effect.Effect<void>): Effect.Effect<boolean> =>
    signal === undefined
      ? Effect.as(write, true)
      : Effect.raceFirst(
          Effect.as(write, true),
          interruptOnAbort(Effect.never, signal).pipe(Effect.exit, Effect.as(false)),
        );
  /** Writes the document in order; false when the abort signal abandoned a write. */
  const write = Effect.fnUntraced(function* (document: TerminalDocument) {
    const renderer = yield* Renderer;
    for (const entry of document.writes) if (!(yield* written(writeEntry(renderer, entry)))) return false;
    return true;
  });
  const settle = (document: TerminalDocument, exit: Exit.Exit<boolean, unknown>): void => {
    if (Exit.isSuccess(exit)) setStatus(exit.value ? document.exitCode : commandInterruptionExitCode(signal));
    else if (!Cause.hasInterruptsOnly(exit.cause)) setStatus(1);
    else if (!options.brokenPipe()) setStatus(commandInterruptionExitCode(signal));
  };
  const commit = (document: TerminalDocument): Effect.Effect<void, never, Renderer> =>
    Effect.suspend(() => {
      if (attempted) return Effect.void;
      attempted = true;
      return write(document).pipe(
        Effect.onExit((exit) => Effect.sync(() => settle(document, exit))),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Effect.interrupt : options.recordDefect(cause),
        ),
      );
    });
  return { commit, attempted: () => attempted };
};
