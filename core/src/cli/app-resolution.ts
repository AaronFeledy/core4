import { type Context, Effect } from "effect";

import {
  AppIdReservedError,
  type LandofileIncludeError,
  type LandofileLockMismatchError,
  type LandofileNotFoundError,
  LandofileParseError,
  type LandofileSandboxError,
  type LandofileTimeoutError,
  type LandofileValidationError,
  type NotImplementedError,
} from "@lando/sdk/errors";
import type { LandofileShape } from "@lando/sdk/schema";
import type { LandofileService } from "@lando/sdk/services";

import { resolveLandofileIncludes } from "../landofile/includes.ts";
import { findDiscoveredLandofilePath } from "../landofile/service.ts";

const RESERVED_APP_IDS: ReadonlySet<string> = new Set(["global"]);

export type UserLandofileError =
  | LandofileNotFoundError
  | LandofileParseError
  | LandofileValidationError
  | LandofileSandboxError
  | LandofileTimeoutError
  | NotImplementedError
  | LandofileIncludeError
  | LandofileLockMismatchError
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
  landofileService.discover.pipe(
    Effect.flatMap((landofile) => {
      if (landofile.includes === undefined || landofile.includes.length === 0)
        return Effect.succeed(landofile);
      return Effect.tryPromise({
        try: () => findDiscoveredLandofilePath(process.cwd()),
        catch: (cause) =>
          cause instanceof LandofileParseError
            ? cause
            : new LandofileParseError({
                message:
                  cause instanceof Error ? cause.message : "Failed to locate the discovered Landofile root.",
                filePath: process.cwd(),
                line: undefined,
                column: undefined,
                cause,
              }),
      }).pipe(Effect.flatMap(({ appRoot }) => resolveLandofileIncludes({ landofile, appRoot })));
    }),
    Effect.tap(assertUserAppIdNotReserved),
  );
