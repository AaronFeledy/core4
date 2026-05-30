import { type Context, Effect } from "effect";

import {
  AppIdReservedError,
  type LandofileNotFoundError,
  type LandofileParseError,
  type LandofileSandboxError,
  type LandofileTimeoutError,
  type LandofileValidationError,
  type NotImplementedError,
} from "@lando/sdk/errors";
import type { LandofileShape } from "@lando/sdk/schema";
import type { LandofileService } from "@lando/sdk/services";

const RESERVED_APP_IDS: ReadonlySet<string> = new Set(["global"]);

export type UserLandofileError =
  | LandofileNotFoundError
  | LandofileParseError
  | LandofileValidationError
  | LandofileSandboxError
  | LandofileTimeoutError
  | NotImplementedError
  | AppIdReservedError;

export const assertUserAppIdNotReserved = (
  landofile: LandofileShape,
): Effect.Effect<void, AppIdReservedError> => {
  const resolved = landofile.name ?? "app";
  return RESERVED_APP_IDS.has(resolved)
    ? Effect.fail(new AppIdReservedError({ reserved: resolved }))
    : Effect.void;
};

export const loadUserLandofile = (
  landofileService: Context.Tag.Service<typeof LandofileService>,
): Effect.Effect<LandofileShape, UserLandofileError> =>
  landofileService.discover.pipe(Effect.tap(assertUserAppIdNotReserved));
