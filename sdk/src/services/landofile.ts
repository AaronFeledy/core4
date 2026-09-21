import { Context, type Effect } from "effect";

import type {
  AppIdReservedError,
  ComposeKeyRejectedError,
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
  ToolingIncludeCycleError,
} from "../errors/index.ts";
import type { LandofileShape } from "../schema/index.ts";

export type LandofileServiceError =
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
  | ToolingIncludeCycleError
  | NotImplementedError
  | ComposeKeyRejectedError
  | ManagedFileTransactionError;

export type UserLandofileError = LandofileServiceError | LandofileVersionConstraintError | AppIdReservedError;

export class LandofileService extends Context.Tag("@lando/core/LandofileService")<
  LandofileService,
  {
    readonly discover: Effect.Effect<LandofileShape, LandofileServiceError>;
  }
>() {}
