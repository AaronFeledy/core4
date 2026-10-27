import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type TransactionOptions, makeManagedFileTransactions } from "@lando/managed-file/transaction";
import { InitTargetExistsError } from "@lando/sdk/errors";
import type { ConfigTranslateDiagnostic, RecipeManifest } from "@lando/sdk/schema";
import type { ConfigTranslatorShape, RecipeDecomposerFactory } from "@lando/sdk/services";
import { Effect } from "effect";
import { encodeRecipeLandofile } from "./init-pipeline/encoding.ts";
import {
  type RecipeInitBlockedError,
  RecipeInitCommitError,
  RecipeInitPostInitError,
} from "./init-pipeline/errors.ts";
import { runBoundPostInit } from "./init-pipeline/post-init.ts";
import type { PostInitOutcome, RunPostInitOptions } from "./post-init/runtime.ts";
import type { PreparedRecipeInit } from "./prepared-init.ts";

export {
  RecipeInitBlockedError,
  RecipeInitCommitError,
  RecipeInitPostInitError,
} from "./init-pipeline/errors.ts";
export { prepareRecipeInit } from "./prepared-init.ts";
export interface RecipeLandofilePreviewRequest {
  readonly manifest: RecipeManifest;
  readonly decomposer: RecipeDecomposerFactory;
  readonly answers: Readonly<Record<string, unknown>>;
  readonly secretAnswers?: Readonly<Record<string, string>>;
  readonly appName: string;
  readonly appRoot?: string;
  readonly encoder: ConfigTranslatorShape;
}
export interface RecipeInitPipelineRequest extends TransactionOptions {
  readonly prepared: PreparedRecipeInit;
  readonly postInitEnabled?: boolean;
  readonly runPostInit?: (options: RunPostInitOptions) => Promise<PostInitOutcome>;
}
export interface RecipeLandofilePreview {
  readonly text: string;
  readonly diagnostics: readonly ConfigTranslateDiagnostic[];
}
export type RecipeInitReceipt = Effect.Success<
  ReturnType<ReturnType<typeof makeManagedFileTransactions>["run"]>
>;
export interface RecipeInitPipelineResult {
  readonly landofilePath: string;
  readonly auxiliaryFiles: readonly string[];
  readonly backups: readonly string[];
  readonly diagnostics: readonly ConfigTranslateDiagnostic[];
  readonly postInit: PostInitOutcome;
  readonly receipt: RecipeInitReceipt;
}
export const previewRecipeLandofile = (
  request: RecipeLandofilePreviewRequest,
): Effect.Effect<RecipeLandofilePreview, RecipeInitBlockedError> =>
  Effect.map(encodeRecipeLandofile(request), ({ text, diagnostics }) => ({ text, diagnostics }));

export const runRecipeInitPipeline = Effect.fn("RecipeInitPipeline.run")(function* (
  request: RecipeInitPipelineRequest,
) {
  const plan = request.prepared;
  const landofilePath = join(plan.appRoot, ".lando.yml");
  const conflict = plan.conflicts[0];
  if (conflict !== undefined)
    return yield* Effect.fail(
      new InitTargetExistsError({
        message: "Init target already has a Landofile.",
        path: join(plan.appRoot, conflict),
        remediation: "Remove the existing Landofile or choose a different directory.",
      }),
    );
  yield* Effect.tryPromise({
    try: () => mkdir(plan.appRoot, { recursive: true }),
    catch: () =>
      new RecipeInitCommitError({
        phase: "prepare",
        reason: "io",
        message: "Could not create the initialization destination.",
        remediation: "Check destination permissions before retrying initialization.",
      }),
  });
  const transactions = makeManagedFileTransactions(request);
  const receipt = yield* transactions
    .run({
      appRoot: plan.appRoot,
      operations: plan.outputs.map(({ destination, content, mode }) => ({
        kind: "create",
        path: destination,
        content,
        mode,
      })),
      readConditions: [{ path: ".lando.ts", expectedBefore: { present: false } }],
    })
    .pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const journal = yield* transactions
            .readJournal(plan.appRoot)
            .pipe(Effect.orElseSucceed(() => null));
          return yield* Effect.fail(
            new RecipeInitCommitError({
              phase: error.phase,
              reason: error.reason,
              message: plan.redact(
                `Recipe static publication failed (${error.phase}/${error.reason})${error.path === "" ? "" : ` at ${error.path}`}. No post-init actions ran; published files were not rolled back.`,
              ),
              remediation: plan.redact(error.remediation),
              ...(journal === null ? {} : { transactionId: journal.id, transactionState: journal.state }),
            }),
          );
        }),
      ),
    );
  const auxiliaryFiles = plan.outputs.slice(1).map(({ destination }) => join(plan.appRoot, destination));
  const postFailure = (failedAction: string) =>
    new RecipeInitPostInitError({
      message: `Recipe action ${failedAction} failed; committed files were kept. External side effects were NOT rolled back.`,
      remediation:
        "Inspect the named action and committed files before retrying. External effects are not recoverable by the static transaction.",
      committedLandofile: landofilePath,
      committedAuxiliaryFiles: auxiliaryFiles,
      failedAction,
      rolledBack: false,
    });
  const postInit =
    request.postInitEnabled === false
      ? { executed: [] }
      : yield* runBoundPostInit({ request, redact: plan.redact, postFailure });
  return {
    landofilePath,
    auxiliaryFiles,
    backups: receipt.backups.map((path) => join(plan.appRoot, path)),
    diagnostics: plan.diagnostics,
    postInit,
    receipt,
  } satisfies RecipeInitPipelineResult;
});
