import { Effect, Result } from "effect";

import { LandofileWriteValidationError } from "@lando/sdk/errors";
import { type ValidationIssue, validationIssue } from "@lando/sdk/schema";
import { recordPreexistingConfigIssues } from "../config/config-warnings.ts";
import { parsePathSegments, setAtPath } from "./dot-path";
import { prepareConfigEdit } from "./prepare-edit";
import { parseTypedValue } from "./value-parse";

import {
  type ValueType,
  applySetMutation,
  applyUnsetMutation,
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
  D extends Result.Result<unknown, readonly ValidationIssue[]>,
  ERead,
  EWrite,
  EAfter = never,
  R = never,
  EParse = never,
> {
  readonly file: string;
  readonly readText: Effect.Effect<string, ERead, R>;
  readonly parse: (
    text: string,
  ) => Record<string, unknown> | Effect.Effect<Record<string, unknown>, EParse, R>;
  readonly editCommand: string;
  readonly decode: (next: unknown) => D | Effect.Effect<D, EAfter, R>;
  readonly afterDecode?: (decoded: D) => EAfter | undefined;
  readonly writeText: (file: string, text: string) => Effect.Effect<void, EWrite, R>;
}

const persistMutation = Effect.fnUntraced(function* <
  D extends Result.Result<unknown, readonly ValidationIssue[]>,
  ERead,
  EWrite,
  EAfter = never,
  R = never,
  EParse = never,
>(
  input: ConfigVerbIo<D, ERead, EWrite, EAfter, R, EParse> & { readonly key: string },
  mutation: { readonly text: string; readonly shouldWrite: boolean; readonly decoded: D },
): Effect.fn.Return<void, LandofileWriteValidationError | EAfter | EWrite, R> {
  const afterError = input.afterDecode?.(mutation.decoded);
  if (afterError !== undefined) return yield* Effect.fail(afterError);
  if (mutation.shouldWrite) {
    yield* input.writeText(input.file, mutation.text);
  }
  if (Result.isFailure(mutation.decoded)) {
    yield* recordPreexistingConfigIssues(input.file, mutation.decoded.failure);
  }
});

const resolve = <A, E, R>(value: A | Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.isEffect(value) ? value : Effect.succeed(value);

interface DecodeAttempt {
  readonly label: string;
  readonly issues: readonly ValidationIssue[];
}

const interpretationLabel = (value: unknown): string => {
  if (typeof value === "string") return "text";
  if (value === null) return "null";
  if (typeof value === "object") return "JSON";
  return typeof value;
};

const issueIdentity = (issue: ValidationIssue): string => JSON.stringify([issue.path, issue.message]);

const blockingIssues = (
  issues: readonly ValidationIssue[],
  baseline: readonly ValidationIssue[],
  key: string,
): readonly ValidationIssue[] => {
  const existing = new Set(baseline.map(issueIdentity));
  const path = parsePathSegments(key)?.map((segment) =>
    segment.kind === "key" ? segment.key : segment.index,
  );
  return issues.filter(
    (issue) =>
      !existing.has(issueIdentity(issue)) || path?.every((segment, index) => issue.path[index] === segment),
  );
};

// Issues every interpretation shares stay as-is; the rest name the interpretation that produced them.
const mergeAttemptIssues = (attempts: readonly DecodeAttempt[]): ValidationIssue[] => {
  const identities = attempts.map((attempt) => new Set(attempt.issues.map(issueIdentity)));
  const seen = new Set<string>();
  const merged: ValidationIssue[] = [];
  for (const attempt of attempts) {
    for (const issue of attempt.issues) {
      const identity = issueIdentity(issue);
      if (seen.has(identity)) continue;
      seen.add(identity);
      const shared = identities.every((set) => set.has(identity));
      if (shared) {
        merged.push(issue);
      } else {
        merged.push({ ...issue, message: `as ${attempt.label}: ${issue.message}` });
      }
    }
  }
  return merged;
};

const failureRemediation = (attemptCount: number): { readonly remediation?: string } => {
  if (attemptCount > 1) {
    return {
      remediation:
        "Fix the reported issue(s), or pass `--type` to force how the value is parsed, then retry the write. The file was left unchanged.",
    };
  }
  return {};
};

export const runSetVerb = Effect.fnUntraced(function* <
  D extends Result.Result<unknown, readonly ValidationIssue[]>,
  ERead,
  EWrite,
  EAfter = never,
  R = never,
  EParse = never,
>(
  input: ConfigVerbIo<D, ERead, EWrite, EAfter, R, EParse> & {
    readonly key: string;
    readonly raw: string;
    readonly type?: ValueType | undefined;
    readonly dryRun: boolean;
  },
) {
  const source = yield* input.readText;
  const tree = yield* resolve(input.parse(source));
  const mutation = applySetMutation({
    tree,
    key: input.key,
    raw: input.raw,
    type: input.type ?? "string",
    file: input.file,
  });
  if (Result.isFailure(mutation)) return yield* Effect.fail(mutation.failure);
  const candidates = [mutation.success];
  if (input.type === undefined) {
    const parsed = parseTypedValue(input.raw, "yaml");
    if (Result.isSuccess(parsed) && typeof parsed.success !== "string") {
      candidates.push({ next: setAtPath(tree, input.key, parsed.success), value: parsed.success });
    }
  }
  const attempts: DecodeAttempt[] = [];
  let baseline: readonly ValidationIssue[] | undefined;
  for (const candidate of candidates) {
    const decoded = yield* resolve(input.decode(candidate.next));
    const remainingIssues = Result.isFailure(decoded) ? decoded.failure : [];
    if (Result.isFailure(decoded) && baseline === undefined) {
      const original = yield* resolve(input.decode(tree));
      baseline = Result.isFailure(original) ? original.failure : [];
    }
    const blocking = blockingIssues(remainingIssues, baseline ?? [], input.key);
    if (blocking.length === 0) {
      const text = yield* prepareConfigEdit({
        ...input,
        source,
        tree,
        next: candidate.next,
        operation: "set",
      });
      yield* persistMutation(input, { text, shouldWrite: !input.dryRun, decoded });
      return {
        key: input.key,
        value: candidate.value,
        changed: true as const,
        dryRun: input.dryRun,
        ...(remainingIssues.length > 0 ? { remainingIssues } : {}),
      };
    }
    attempts.push({ label: interpretationLabel(candidate.value), issues: blocking });
  }
  const issues = mergeAttemptIssues(attempts);
  return yield* Effect.fail(
    writeValidationErrorFromIssues({
      file: input.file,
      path: input.key,
      issues,
      ...failureRemediation(attempts.length),
    }),
  );
});

export const runUnsetVerb = Effect.fnUntraced(function* <
  D extends Result.Result<unknown, readonly ValidationIssue[]>,
  ERead,
  EWrite,
  EAfter = never,
  R = never,
  EParse = never,
>(
  input: ConfigVerbIo<D, ERead, EWrite, EAfter, R, EParse> & {
    readonly key: string;
    readonly dryRun: boolean;
  },
) {
  const source = yield* input.readText;
  const tree = yield* resolve(input.parse(source));
  const mutation = applyUnsetMutation({ tree, key: input.key, file: input.file });
  if (Result.isFailure(mutation)) return yield* Effect.fail(mutation.failure);
  const decoded = yield* resolve(input.decode(mutation.success.next));
  const remainingIssues = Result.isFailure(decoded) ? decoded.failure : [];
  const original = Result.isFailure(decoded) ? yield* resolve(input.decode(tree)) : decoded;
  const baseline = Result.isFailure(original) ? original.failure : [];
  const issues = blockingIssues(remainingIssues, baseline, input.key);
  if (issues.length > 0) {
    return yield* Effect.fail(
      writeValidationErrorFromIssues({
        file: input.file,
        issues,
        path: input.key,
      }),
    );
  }
  const text = mutation.success.changed
    ? yield* prepareConfigEdit({ ...input, source, tree, next: mutation.success.next, operation: "unset" })
    : source;
  yield* persistMutation(input, {
    text,
    shouldWrite: !input.dryRun && mutation.success.changed,
    decoded,
  });
  return {
    key: input.key,
    changed: mutation.success.changed,
    dryRun: input.dryRun,
    ...(remainingIssues.length > 0 ? { remainingIssues } : {}),
  };
});
