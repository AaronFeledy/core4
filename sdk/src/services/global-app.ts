import { Context, type Effect, type Scope } from "effect";

import type {
  GlobalAppError,
  GlobalDistConflictError,
  GlobalLandofilePathConflictError,
} from "../errors/index.ts";
import type { AbsolutePath, ServiceConfig } from "../schema/index.ts";

export interface GlobalAppPaths {
  readonly root: AbsolutePath;
  readonly distLandofile: AbsolutePath;
  readonly userLandofile: AbsolutePath;
}

export interface GlobalDistResult {
  readonly path: AbsolutePath;
  readonly status: "created" | "updated" | "unchanged";
  readonly serviceIds: ReadonlyArray<string>;
}

export class GlobalAppService extends Context.Tag("@lando/core/GlobalAppService")<
  GlobalAppService,
  {
    readonly id: "global";
    readonly root: Effect.Effect<AbsolutePath, GlobalAppError>;
    readonly ensureRoot: Effect.Effect<void, GlobalAppError, Scope.Scope>;
    readonly paths: Effect.Effect<GlobalAppPaths, GlobalAppError>;
    readonly ensureUserLandofile: Effect.Effect<
      { readonly path: AbsolutePath; readonly created: boolean },
      GlobalAppError | GlobalLandofilePathConflictError
    >;
    readonly ensureRunning: (services: ReadonlyArray<string>) => Effect.Effect<
      ReadonlyArray<{
        readonly name: string;
        readonly state: string;
        readonly endpoints: ReadonlyArray<string>;
      }>,
      GlobalAppError
    >;
    readonly regenerateDist: (input?: { readonly services?: Record<string, ServiceConfig> }) => Effect.Effect<
      GlobalDistResult,
      GlobalAppError | GlobalDistConflictError
    >;
  }
>() {}
