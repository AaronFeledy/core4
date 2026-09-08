import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { makeManagedFileTransactions } from "@lando/managed-file/transaction";
import { resolveLandoRoots } from "@lando/paths";
import { ConfigTranslateError } from "@lando/sdk/errors";
import { Effect } from "effect";
import type { DocumentSetShape } from "./app-config-translate-document-set.ts";
import type { AppConfigTranslateResult } from "./app-config-translate-output.ts";

export const writeTranslateTargets = (
  appRoot: string,
  preview: Extract<AppConfigTranslateResult, { readonly mode: "preview" }>,
  shape: DocumentSetShape,
) =>
  Effect.gen(function* () {
    if (preview.target !== "lando4")
      return yield* Effect.fail(
        new ConfigTranslateError({
          message: `Target ${preview.target} is preview-only.`,
          remediation: "Use --to lando4 to write.",
        }),
      );
    const blocking = preview.diagnostics.filter(
      (diagnostic) => diagnostic.kind === "unsupported" || diagnostic.kind === "non-portable",
    );
    if (blocking.length > 0)
      return yield* Effect.fail(
        new ConfigTranslateError({
          message: `Cannot write translation: ${blocking.map((diagnostic) => `${diagnostic.kind}: ${diagnostic.message}`).join("; ")}`,
          remediation: "Resolve the reported diagnostics before using --write.",
        }),
      );
    if (shape.mode === "single-layer") {
      const unselected = [
        ...preview.targets
          .filter((target) => existsSync(target.path))
          .map((target) => relative(appRoot, target.path).replaceAll("\\", "/")),
        ...preview.deletions.map((deletion) => String(deletion.sourceId)),
      ].find((path) => !shape.selectedSourceIds.includes(path));
      if (unselected !== undefined)
        return yield* Effect.fail(
          new ConfigTranslateError({
            message: `Cannot modify unselected source ${unselected}.`,
            remediation: `Select it explicitly with --file ${unselected}.`,
          }),
        );
    }
    const transactions = makeManagedFileTransactions({ journalRoot: () => resolveLandoRoots().userDataRoot });
    const receipt = yield* transactions
      .run({
        appRoot,
        operations: [
          ...preview.targets.map((target) => ({
            kind: "write" as const,
            path: relative(appRoot, target.path),
            content: target.content,
          })),
          ...preview.deletions.map((deletion) => ({
            kind: "remove" as const,
            path: String(deletion.sourceId),
          })),
        ],
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ConfigTranslateError({
              message: `Translation transaction ${cause.phase}/${cause.reason}: ${cause.path}`,
              cause: cause.cause,
              remediation: cause.remediation,
            }),
        ),
      );
    return {
      mode: "write" as const,
      inputPath: preview.inputPath,
      target: preview.target,
      written: receipt.written.map((path) => join(appRoot, path)),
      backups: receipt.backups.map((path) => join(appRoot, path)),
      removed: receipt.removed.map((path) => join(appRoot, path)),
      diagnostics: preview.diagnostics,
      deletions: preview.deletions,
    };
  });
