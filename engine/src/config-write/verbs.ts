import { Effect, Result } from "effect";

import { LandofileWriteValidationError } from "@lando/sdk/errors";
import { validationIssue } from "@lando/sdk/schema";

import {
  type ValueType,
  applySetMutation,
  applyUnsetMutation,
  decodeIssues,
  emitConfigYaml,
  writeValidationErrorFromIssues,
} from "./write-core";

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

export interface ConfigVerbIo<
  D extends Result.Result<unknown, unknown>,
  ERead,
  EWrite,
  EAfter = never,
  R = never,
> {
  readonly file: string;
  readonly readTree: Effect.Effect<Record<string, unknown>, ERead, R>;
  readonly decode: (next: unknown) => D;
  readonly afterDecode?: (decoded: D) => EAfter | undefined;
  readonly writeText: (file: string, text: string) => Effect.Effect<void, EWrite, R>;
}

const decodeAndWrite = Effect.fnUntraced(function* <
  D extends Result.Result<unknown, unknown>,
  ERead,
  EWrite,
  EAfter = never,
  R = never,
>(
  input: ConfigVerbIo<D, ERead, EWrite, EAfter, R> & { readonly key: string },
  next: unknown,
  shouldWrite: boolean,
): Effect.fn.Return<void, LandofileWriteValidationError | EAfter | EWrite, R> {
  const decoded = input.decode(next);
  const issues = decodeIssues(decoded);
  if (issues.length > 0) {
    return yield* Effect.fail(writeValidationErrorFromIssues({ file: input.file, issues, path: input.key }));
  }
  const afterError = input.afterDecode?.(decoded);
  if (afterError !== undefined) return yield* Effect.fail(afterError);
  if (shouldWrite) {
    const emitted = emitConfigYaml({ file: input.file, value: next, path: input.key });
    if (Result.isFailure(emitted)) return yield* Effect.fail(emitted.failure);
    yield* input.writeText(input.file, emitted.success);
  }
});

export const runSetVerb = Effect.fnUntraced(function* <
  D extends Result.Result<unknown, unknown>,
  ERead,
  EWrite,
  EAfter = never,
  R = never,
>(
  input: ConfigVerbIo<D, ERead, EWrite, EAfter, R> & {
    readonly key: string;
    readonly raw: string;
    readonly type: ValueType;
    readonly dryRun: boolean;
  },
) {
  const tree = yield* input.readTree;
  const mutation = applySetMutation({
    tree,
    key: input.key,
    raw: input.raw,
    type: input.type,
    file: input.file,
  });
  if (Result.isFailure(mutation)) return yield* Effect.fail(mutation.failure);
  yield* decodeAndWrite(input, mutation.success.next, !input.dryRun);
  return { key: input.key, value: mutation.success.value, changed: true as const, dryRun: input.dryRun };
});

export const runUnsetVerb = Effect.fnUntraced(function* <
  D extends Result.Result<unknown, unknown>,
  ERead,
  EWrite,
  EAfter = never,
  R = never,
>(
  input: ConfigVerbIo<D, ERead, EWrite, EAfter, R> & {
    readonly key: string;
    readonly dryRun: boolean;
  },
) {
  const tree = yield* input.readTree;
  const mutation = applyUnsetMutation({ tree, key: input.key, file: input.file });
  if (Result.isFailure(mutation)) return yield* Effect.fail(mutation.failure);
  yield* decodeAndWrite(input, mutation.success.next, !input.dryRun && mutation.success.changed);
  return { key: input.key, changed: mutation.success.changed, dryRun: input.dryRun };
});
