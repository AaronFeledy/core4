import type { LandofileWriteValidationError } from "@lando/sdk/errors";
import type { ValidationIssue, ValidationIssuePath } from "@lando/sdk/schema";
import { Effect, Result } from "effect";
import { collectDocumentDiagnostics } from "./diagnostics.ts";
import { type ConfigDocument, persistMutation, resolveDocumentEffect as resolve } from "./document.ts";
import { setAtPath, unsetAtPath } from "./dot-path";
import { type ConfigSchemaName, configKeySummary } from "./key-schema.ts";
import { prepareConfigEdit } from "./prepare-edit";
import { parseTypedValue } from "./value-parse";
import {
  type ValueType,
  parseConfigPath,
  parseConfigValue,
  resolveConfigPath,
  writeValidationErrorFromIssues,
} from "./write-core";
import { authoredTreesEqual } from "./yaml-verify.ts";

export {
  type ConfigDocument,
  editorFailedError,
  noEditorError,
} from "./document.ts";
export { runEditVerb } from "./edit.ts";

interface DecodeAttempt {
  readonly label: string;
  readonly issues: readonly ValidationIssue[];
}

type WritePathPolicy = (path: ValidationIssuePath) => LandofileWriteValidationError | undefined;

const interpretationLabel = (value: unknown): string => {
  if (typeof value === "string") return "text";
  if (value === null) return "null";
  if (typeof value === "object") return "JSON";
  return typeof value;
};

const issueIdentity = ({ path, message, source }: ValidationIssue): string =>
  JSON.stringify([
    path,
    message,
    source?.layer,
    source?.path,
    source !== undefined && "file" in source ? source.file : undefined,
    source !== undefined && "variable" in source ? source.variable : undefined,
  ]);

const blockingIssues = (
  issues: readonly ValidationIssue[],
  baseline: readonly ValidationIssue[],
  path: ValidationIssuePath,
): readonly ValidationIssue[] => {
  const existing = new Set(baseline.map(issueIdentity));
  return issues.filter(
    (issue) =>
      !existing.has(issueIdentity(issue)) || path.every((segment, index) => issue.path[index] === segment),
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

const failureRemediation = (
  attempts: readonly DecodeAttempt[],
  selector: { readonly key: string; readonly path: ValidationIssuePath },
  schema: ConfigSchemaName | undefined,
): string => {
  const identities = attempts.map((attempt) =>
    JSON.stringify([...new Set(attempt.issues.map(issueIdentity))].sort()),
  );
  const summary = schema === undefined ? undefined : configKeySummary(schema, selector.path);
  const takes = summary === undefined ? "" : `\`${selector.key}\` takes ${summary}. `;
  const typeHint = new Set(identities).size > 1 ? ", or pass `--type` to force how the value is parsed" : "";
  return `${takes}Fix the reported issue(s)${typeHint}, then retry the write. The file was left unchanged.`;
};

export const runSetVerb = Effect.fnUntraced(function* <
  D extends Result.Result<unknown, readonly ValidationIssue[]>,
  ERead,
  EWrite,
  EAfter = never,
  R = never,
  EParse = never,
>(
  input: ConfigDocument<D, ERead, EWrite, EAfter, R, EParse> & {
    readonly key: string;
    readonly checkPath?: WritePathPolicy;
    readonly raw: string;
    readonly type?: ValueType | undefined;
    readonly dryRun: boolean;
  },
) {
  const parsedPath = parseConfigPath(input.key, input.file);
  const refusal = Result.isSuccess(parsedPath) ? input.checkPath?.(parsedPath.success) : undefined;
  if (refusal !== undefined) return yield* Effect.fail(refusal);
  const source = yield* input.readText;
  const tree = yield* resolve(input.parse(source));
  yield* Effect.fromResult(parsedPath);
  const path = yield* Effect.fromResult(resolveConfigPath(tree, input.key, input.file));
  const value = yield* Effect.fromResult(parseConfigValue(input.raw, input.type ?? "string", input.file));
  const candidates = [{ next: setAtPath(tree, path, value), value }];
  if (input.type === undefined) {
    const parsed = parseTypedValue(input.raw, "yaml");
    if (Result.isSuccess(parsed) && typeof parsed.success !== "string") {
      candidates.push({ next: setAtPath(tree, path, parsed.success), value: parsed.success });
    }
  }
  const attempts: DecodeAttempt[] = [];
  let baseline: readonly ValidationIssue[] | undefined;
  for (const candidate of candidates) {
    const evaluated = yield* collectDocumentDiagnostics(
      Effect.suspend(() => resolve(input.decode(candidate.next))),
    );
    const decoded = evaluated.value;
    const remainingIssues = Result.isFailure(decoded) ? decoded.failure : [];
    if (Result.isFailure(decoded) && baseline === undefined) {
      const { value: original } = yield* collectDocumentDiagnostics(
        Effect.suspend(() => resolve((input.decodeBaseline ?? input.decode)(tree))),
      );
      baseline = Result.isFailure(original) ? original.failure : [];
    }
    const blocking = blockingIssues(remainingIssues, baseline ?? [], path);
    if (blocking.length === 0) {
      const changed = !authoredTreesEqual(tree, candidate.next);
      const text = changed
        ? yield* prepareConfigEdit({
            ...input,
            path,
            source,
            tree,
            next: candidate.next,
            operation: "set",
          })
        : source;
      yield* persistMutation(input, {
        text,
        shouldWrite: changed && !input.dryRun,
        decoded,
        warnings: evaluated.warnings,
      });
      return {
        key: input.key,
        value: candidate.value,
        changed,
        dryRun: input.dryRun,
        ...(remainingIssues.length > 0 ? { remainingIssues } : {}),
      };
    }
    attempts.push({ label: interpretationLabel(candidate.value), issues: blocking });
  }
  const kindAccepted = attempts.filter(
    (attempt) =>
      !attempt.issues.some(
        (issue) =>
          issue.kind === "type" &&
          issue.path.length === path.length &&
          path.every((segment, index) => segment === issue.path[index]),
      ),
  );
  const reported = kindAccepted.length > 0 ? kindAccepted : attempts;
  const issues = mergeAttemptIssues(reported);
  return yield* Effect.fail(
    writeValidationErrorFromIssues({
      file: input.file,
      path: input.key,
      issues,
      remediation: failureRemediation(reported, { key: input.key, path }, input.schema),
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
  input: ConfigDocument<D, ERead, EWrite, EAfter, R, EParse> & {
    readonly key: string;
    readonly checkPath?: WritePathPolicy;
    readonly dryRun: boolean;
  },
) {
  const parsedPath = parseConfigPath(input.key, input.file);
  const refusal = Result.isSuccess(parsedPath) ? input.checkPath?.(parsedPath.success) : undefined;
  if (refusal !== undefined) return yield* Effect.fail(refusal);
  const source = yield* input.readText;
  const tree = yield* resolve(input.parse(source));
  yield* Effect.fromResult(parsedPath);
  const path = yield* Effect.fromResult(resolveConfigPath(tree, input.key, input.file));
  const mutation = unsetAtPath(tree, path);
  const evaluated = yield* collectDocumentDiagnostics(
    Effect.suspend(() => resolve(input.decode(mutation.next))),
  );
  const decoded = evaluated.value;
  const remainingIssues = Result.isFailure(decoded) ? decoded.failure : [];
  const original = Result.isFailure(decoded)
    ? (yield* collectDocumentDiagnostics(
        Effect.suspend(() => resolve((input.decodeBaseline ?? input.decode)(tree))),
      )).value
    : decoded;
  const baseline = Result.isFailure(original) ? original.failure : [];
  const issues = blockingIssues(remainingIssues, baseline, path);
  if (issues.length > 0) {
    return yield* Effect.fail(
      writeValidationErrorFromIssues({
        file: input.file,
        issues,
        path: input.key,
      }),
    );
  }
  const text = mutation.changed
    ? yield* prepareConfigEdit({ ...input, path, source, tree, next: mutation.next, operation: "unset" })
    : source;
  yield* persistMutation(input, {
    text,
    shouldWrite: !input.dryRun && mutation.changed,
    decoded,
    warnings: evaluated.warnings,
  });
  return {
    key: input.key,
    changed: mutation.changed,
    dryRun: input.dryRun,
    ...(remainingIssues.length > 0 ? { remainingIssues } : {}),
  };
});
