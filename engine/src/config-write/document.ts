import { LandofileWriteValidationError } from "@lando/sdk/errors";
import { type CommandWarning, type ValidationIssue, validationIssue } from "@lando/sdk/schema";
import { Effect, Result } from "effect";
import { recordConfigWarning, recordPreexistingConfigIssues } from "../config/config-warnings.ts";

export interface ConfigDocument<
  D extends Result.Result<unknown, readonly ValidationIssue[]>,
  ERead,
  EWrite,
  EAfter = never,
  R = never,
  EParse = never,
> {
  readonly file: string;
  /** Persisted text, never the seeded editor buffer. An absent file reads as empty text. */
  readonly readText: Effect.Effect<string, ERead, R>;
  readonly parse: (
    text: string,
  ) => Record<string, unknown> | Effect.Effect<Record<string, unknown>, EParse, R>;
  readonly editCommand: string;
  readonly decode: (next: unknown) => D | Effect.Effect<D, EAfter, R>;
  /** Decodes the unchanged file for comparison; must not record warnings. Defaults to `decode`. */
  readonly decodeBaseline?: ((current: unknown) => D | Effect.Effect<D, EAfter, R>) | undefined;
  /** Validates exact editor bytes when tree decoding alone cannot preserve document semantics. */
  readonly validateText?: ((text: string) => D | Effect.Effect<D, EAfter | EParse, R>) | undefined;
  readonly afterDecode?: (decoded: D) => EAfter | undefined;
  readonly writeText: (file: string, text: string) => Effect.Effect<void, EWrite, R>;
}

export const resolveDocumentEffect = <A, E, R>(value: A | Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.isEffect(value) ? value : Effect.succeed(value);

export const persistMutation = Effect.fnUntraced(function* <
  D extends Result.Result<unknown, readonly ValidationIssue[]>,
  ERead,
  EWrite,
  EAfter = never,
  R = never,
  EParse = never,
>(
  input: ConfigDocument<D, ERead, EWrite, EAfter, R, EParse>,
  mutation: {
    readonly text: string;
    readonly shouldWrite: boolean;
    readonly decoded: D;
    readonly warnings?: readonly CommandWarning[];
  },
): Effect.fn.Return<void, EAfter | EWrite, R> {
  const afterError = input.afterDecode?.(mutation.decoded);
  if (afterError !== undefined) return yield* Effect.fail(afterError);
  if (mutation.shouldWrite) yield* input.writeText(input.file, mutation.text);
  for (const warning of mutation.warnings ?? []) yield* recordConfigWarning(warning);
  if (Result.isFailure(mutation.decoded)) {
    yield* recordPreexistingConfigIssues(input.file, mutation.decoded.failure);
  }
});

export const noEditorError = (file: string): LandofileWriteValidationError =>
  new LandofileWriteValidationError({
    message: "No editor is configured.",
    file,
    issues: [validationIssue([], "Neither $VISUAL nor $EDITOR is set.")],
    remediation: "Set `$VISUAL` or `$EDITOR`, or pass `--editor <bin>`.",
  });

export const editorFailedError = (
  file: string,
  reason: string,
  remediation: string,
): LandofileWriteValidationError =>
  new LandofileWriteValidationError({
    message: `The editor session failed: ${reason}`,
    file,
    issues: [validationIssue([], reason)],
    remediation,
  });
