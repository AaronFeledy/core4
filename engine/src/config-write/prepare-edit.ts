import { validationIssue } from "@lando/sdk/schema";
import { Effect, Result } from "effect";
import { writeValidationErrorFromIssues } from "./write-core";
import { type YamlEdit, spliceYamlEdit } from "./yaml-edit";
import { authoredTreesEqual, canonicalRewrite } from "./yaml-verify";

export const prepareConfigEdit = Effect.fnUntraced(function* <E, R>(
  input: YamlEdit & {
    readonly file: string;
    readonly tree: Record<string, unknown>;
    readonly editCommand: string;
    readonly parse: (text: string) => Record<string, unknown> | Effect.Effect<Record<string, unknown>, E, R>;
  },
) {
  const verify = Effect.fnUntraced(function* (text: string) {
    const parsing = input.parse(text);
    const parsed = yield* Effect.result(Effect.isEffect(parsing) ? parsing : Effect.succeed(parsing));
    return Result.isSuccess(parsed) && authoredTreesEqual(parsed.success, input.next);
  });
  const spliced = spliceYamlEdit(input);
  if (Result.isSuccess(spliced) && (yield* verify(spliced.success))) return spliced.success;
  const canonical = canonicalRewrite(input.source, input.tree, input.next);
  if (Result.isSuccess(canonical) && (yield* verify(canonical.success))) return canonical.success;
  const reason = Result.isFailure(spliced)
    ? spliced.failure.reason
    : "The edited serialization does not round-trip to the intended authored tree.";
  return yield* Effect.fail(
    writeValidationErrorFromIssues({
      file: input.file,
      path: input.key,
      issues: [validationIssue([], reason)],
      remediation: `Use \`${input.editCommand}\` or edit the file by hand. The file was left unchanged.`,
    }),
  );
});
