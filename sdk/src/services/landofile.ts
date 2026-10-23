import { Context, type Effect } from "effect";

import type {
  AppIdReservedError,
  ComposeKeyRejectedError,
  ConfigExpressionError,
  Lando3LandofileDetected,
  LandofileDialectMixError,
  LandofileFormConflictError,
  LandofileImportRefMisuseError,
  LandofileIncludeError,
  LandofileLoadLimitError,
  LandofileLoadOutsideRootError,
  LandofileLockMismatchError,
  LandofileNotFoundError,
  LandofileParseError,
  LandofileSandboxError,
  LandofileTimeoutError,
  LandofileValidationError,
  LandofileVersionConstraintError,
  ManagedFileTransactionError,
  NotImplementedError,
  RouteInputError,
} from "../errors/index.ts";
import type { LoadScopedLandofile } from "../schema/index.ts";

export type LandofileServiceError =
  | Lando3LandofileDetected
  | LandofileDialectMixError
  | LandofileNotFoundError
  | LandofileParseError
  | LandofileValidationError
  | RouteInputError
  | LandofileSandboxError
  | LandofileTimeoutError
  | LandofileFormConflictError
  | LandofileIncludeError
  | LandofileLockMismatchError
  | LandofileImportRefMisuseError
  | LandofileLoadLimitError
  | LandofileLoadOutsideRootError
  | NotImplementedError
  | ComposeKeyRejectedError
  | ConfigExpressionError
  | ManagedFileTransactionError;

export type UserLandofileError = LandofileServiceError | LandofileVersionConstraintError | AppIdReservedError;

export class LandofileService extends Context.Service<
  LandofileService,
  {
    readonly discover: Effect.Effect<LoadScopedLandofile, LandofileServiceError>;
  }
>()("@lando/core/LandofileService") {}
