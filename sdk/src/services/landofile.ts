import { Context, type Effect } from "effect";

import type {
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
  LandofileUnknownEventError,
  LandofileValidationError,
  NotImplementedError,
  ToolingIncludeCycleError,
} from "../errors/index.ts";
import type { LandofileShape } from "../schema/index.ts";

export class LandofileService extends Context.Tag("@lando/core/LandofileService")<
  LandofileService,
  {
    readonly discover: Effect.Effect<
      LandofileShape,
      | LandofileNotFoundError
      | LandofileParseError
      | LandofileValidationError
      | LandofileSandboxError
      | LandofileTimeoutError
      | LandofileUnknownEventError
      | LandofileFormConflictError
      | LandofileIncludeError
      | LandofileLockMismatchError
      | LandofileImportRefMisuseError
      | LandofileLoadLimitError
      | LandofileLoadOutsideRootError
      | ToolingIncludeCycleError
      | NotImplementedError
      | ComposeKeyRejectedError
    >;
  }
>() {}
