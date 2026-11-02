import type { ValidationIssue } from "@lando/sdk/schema";
import { Effect, Result } from "effect";
import { collectDocumentDiagnostics } from "./diagnostics.ts";
import {
  type ConfigDocument,
  editorFailedError,
  noEditorError,
  persistMutation,
  resolveDocumentEffect,
} from "./document.ts";
import type { EditorRunResult } from "./editor.ts";
import { writeValidationErrorFromIssues } from "./write-core.ts";

export const runEditVerb = Effect.fnUntraced(function* <
  D extends Result.Result<unknown, readonly ValidationIssue[]>,
  ERead,
  EWrite,
  EAfter = never,
  R = never,
  EParse = never,
  EEditor = never,
>(
  input: ConfigDocument<D, ERead, EWrite, EAfter, R, EParse> & {
    readonly dryRun: boolean;
    readonly openEditor?: ((source: string) => Effect.Effect<EditorRunResult, EEditor, R>) | undefined;
  },
) {
  const source = yield* input.readText;
  if (input.openEditor === undefined) return yield* Effect.fail(noEditorError(input.file));
  const edited = yield* input.openEditor(source);
  switch (edited.kind) {
    case "no-editor":
      return yield* Effect.fail(noEditorError(input.file));
    case "failed":
      return yield* Effect.fail(
        editorFailedError(
          input.file,
          edited.reason,
          `Resolve the editor error and retry \`${input.editCommand}\`. The file was left unchanged.`,
        ),
      );
    case "edited": {
      const evaluated = yield* collectDocumentDiagnostics(
        Effect.gen(function* () {
          return input.validateText === undefined
            ? yield* resolveDocumentEffect(
                input.decode(yield* resolveDocumentEffect(input.parse(edited.content))),
              )
            : yield* resolveDocumentEffect(input.validateText(edited.content));
        }),
      );
      const decoded = evaluated.value;
      if (Result.isFailure(decoded)) {
        return yield* Effect.fail(
          writeValidationErrorFromIssues({ file: input.file, issues: decoded.failure }),
        );
      }
      const changed = edited.content !== source;
      yield* persistMutation(input, {
        text: edited.content,
        shouldWrite: changed && !input.dryRun,
        decoded,
        warnings: evaluated.warnings,
      });
      return { changed, valid: true as const, dryRun: input.dryRun };
    }
    default:
      return edited satisfies never;
  }
});
