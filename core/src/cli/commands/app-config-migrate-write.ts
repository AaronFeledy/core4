import { makeManagedFileTransactions } from "@lando/managed-file/transaction";
import { resolveLandoRoots } from "@lando/paths";
import { createStandaloneRedactor } from "@lando/redaction/service";
import { ManagedFileTransactionError } from "@lando/sdk/errors";
import { emitLandofileYamlEither } from "@lando/sdk/landofile";
import type { ManagedFileTransactionGuard } from "@lando/sdk/services";
import type { PrivateFileAccess } from "@lando/state-store/private-file-access";
import { Effect, Schema } from "effect";
import { CANONICAL_LANDOFILE } from "./app-config-recipe-analysis.ts";

export class AppConfigMigrateError extends Schema.TaggedError<AppConfigMigrateError>()(
  "AppConfigMigrateError",
  {
    message: Schema.String,
    reason: Schema.Literal("unknown-recipe", "identity-mismatch", "confirmation-required", "encode-failed"),
    remediation: Schema.String,
  },
) {}

export class AppConfigMigrateCommitError extends Schema.TaggedError<AppConfigMigrateCommitError>()(
  "AppConfigMigrateCommitError",
  {
    message: Schema.String,
    phase: Schema.String,
    reason: Schema.String,
    remediation: Schema.String,
  },
) {}

/** Dry-run inspects journals without locking; writes recover through ensureConsistent. */
export const honorMigrationJournal = (
  guard: (typeof ManagedFileTransactionGuard)["Service"],
  appRoot: string,
  dryRun: boolean,
) => {
  if (!dryRun) return guard.ensureConsistent(appRoot);
  return guard.pending(appRoot).pipe(
    Effect.flatMap((report) =>
      report === null
        ? Effect.void
        : Effect.fail(
            new ManagedFileTransactionError({
              reason: report.state === "blocked" ? "blocked" : "checkpoint",
              phase: "inspect",
              path: appRoot,
              cause: report.state === "blocked" ? "invariant" : "interrupted-checkpoint",
              remediation:
                report.action === "manual-resolution"
                  ? "Resolve the blocked transaction."
                  : "Re-run without --dry-run so recovery can complete.",
            }),
          ),
    ),
  );
};

interface WriteRecipeMigrationRequest {
  readonly appRoot: string;
  readonly document: Record<string, unknown>;
  readonly expectedBefore: Uint8Array;
  readonly privateFileAccess: PrivateFileAccess;
}

export const writeRecipeMigration = ({
  appRoot,
  document,
  expectedBefore,
  privateFileAccess,
}: WriteRecipeMigrationRequest) =>
  Effect.gen(function* () {
    const content = yield* emitLandofileYamlEither(document).pipe(
      Effect.mapError(
        () =>
          new AppConfigMigrateError({
            reason: "encode-failed",
            message: "Cannot losslessly encode the migrated Landofile.",
            remediation: "Correct unsupported authoring values before retrying.",
          }),
      ),
    );
    const redactor = createStandaloneRedactor("secrets");
    yield* makeManagedFileTransactions({
      journalRoot: () => resolveLandoRoots().userDataRoot,
      privateFileAccess,
    })
      .run({
        appRoot,
        operations: [
          {
            kind: "write",
            path: CANONICAL_LANDOFILE,
            content,
            expectedBefore: {
              present: true,
              digest: new Bun.CryptoHasher("sha256").update(expectedBefore).digest("hex"),
            },
          },
        ],
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new AppConfigMigrateCommitError({
              phase: error.phase,
              reason: error.reason,
              message: redactor.redactString(
                `Recipe migration transaction failed (${error.phase}/${error.reason}) at ${error.path}.`,
              ),
              remediation: redactor.redactString(error.remediation),
            }),
        ),
      );
  });
