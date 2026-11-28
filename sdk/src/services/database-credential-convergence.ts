import { Context, type Effect, type Redacted, Schema } from "effect";
import {
  type AppPlacementError,
  type AppliedStateVersionError,
  type CommandInputValidationError,
  type CommandStdioError,
  type ProviderUnavailableError,
  type SqlCredentialAdminAuthError,
  type SqlCredentialApplyError,
  SqlCredentialMember,
  type SqlCredentialTargetError,
  type SqlServiceAmbiguousError,
  type SqlServiceNotFoundError,
} from "../errors/index.ts";
import { DatabaseConnection } from "../schema/database-connection.ts";
import type { AbsolutePath } from "../schema/primitives.ts";

export const DatabaseCredentialConvergenceResult = Schema.Struct({
  service: Schema.String.annotate({ description: "Name of the selected database service." }),
  family: DatabaseConnection.fields.family.annotate({ description: "Database server family." }),
  outcome: Schema.Literals(["planned", "applied", "already-matched"]).annotate({
    description: "Whether changes are planned, verified as applied, or unnecessary.",
  }),
  changedMembers: Schema.Array(SqlCredentialMember).annotate({
    description: "Application credential fields planned for change or verified as changed.",
  }),
  adminAdoption: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Whether a Lando-managed database administrator is being or was installed.",
    }),
  ),
  databaseCreation: Schema.optionalKey(
    Schema.Struct({
      database: Schema.String.annotate({ description: "Name of the new empty database." }),
      otherDatabases: Schema.Array(Schema.String).annotate({
        description: "Existing sibling database names, up to the reporting limit.",
      }),
      omittedCount: Schema.Int.annotate({ description: "Number of sibling names omitted from the list." }),
    }).annotate({ description: "A planned or verified creation that leaves other databases in place." }),
  ),
  next: Schema.optionalKey(
    Schema.Literals(["lando start", "lando restart"]).annotate({
      description: "Optional follow-up to refresh the service's configured client credentials.",
    }),
  ),
}).annotate({
  description: "Read-only preview or verified result of converging a catalog database's credentials.",
});
export type DatabaseCredentialConvergenceResult = typeof DatabaseCredentialConvergenceResult.Type;

export interface DatabaseCredentialConvergenceRequest {
  readonly root: AbsolutePath;
  readonly service?: string;
  readonly apply: boolean;
  readonly adminUser?: string;
  readonly readPassword?: Effect.Effect<
    Redacted.Redacted<string> | undefined,
    CommandStdioError | CommandInputValidationError
  >;
}

export type DatabaseCredentialConvergenceError =
  | AppPlacementError
  | AppliedStateVersionError
  | ProviderUnavailableError
  | SqlCredentialTargetError
  | SqlCredentialApplyError
  | SqlCredentialAdminAuthError
  | SqlServiceNotFoundError
  | SqlServiceAmbiguousError
  | CommandStdioError
  | CommandInputValidationError;

export class DatabaseCredentialConvergence extends Context.Service<
  DatabaseCredentialConvergence,
  {
    readonly reconcile: (
      request: DatabaseCredentialConvergenceRequest,
    ) => Effect.Effect<DatabaseCredentialConvergenceResult, DatabaseCredentialConvergenceError>;
  }
>()("@lando/core/DatabaseCredentialConvergence") {}
