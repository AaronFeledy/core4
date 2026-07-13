import { Context, type Effect } from "effect";

import type {
  LandofileFormConflictError,
  LandofileIncludeError,
  LandofileLockMismatchError,
  LandofileNotFoundError,
  LandofileParseError,
  LandofileSandboxError,
  LandofileTimeoutError,
  LandofileValidationError,
  NotImplementedError,
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
      | LandofileFormConflictError
      | LandofileIncludeError
      | LandofileLockMismatchError
      | NotImplementedError
    >;
  }
>() {}
