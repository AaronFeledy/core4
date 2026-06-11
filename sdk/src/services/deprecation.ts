import { Context, type Effect, type Option } from "effect";

import type { DeprecatedSurfaceError, DeprecationContradictionError } from "../errors/deprecation.ts";
import type { DeprecationNotice, DeprecationSurfaceKind, DeprecationUse } from "../schema/deprecation.ts";

export interface DeprecationSummaryEntry extends DeprecationUse {
  readonly count: number;
}

export type DeprecationRegistrySource = "core" | "plugin" | "schema-walk";

export class DeprecationService extends Context.Tag("@lando/core/DeprecationService")<
  DeprecationService,
  {
    readonly use: (use: DeprecationUse) => Effect.Effect<void, DeprecatedSurfaceError>;
    readonly summary: () => Effect.Effect<ReadonlyArray<DeprecationSummaryEntry>>;
    readonly lookup: (
      kind: DeprecationSurfaceKind,
      id: string,
    ) => Effect.Effect<Option.Option<DeprecationNotice>>;
    readonly register: (
      source: DeprecationRegistrySource,
      kind: DeprecationSurfaceKind,
      id: string,
      notice: DeprecationNotice,
    ) => Effect.Effect<void>;
    readonly registerAlias: (
      source: DeprecationRegistrySource,
      kind: DeprecationSurfaceKind,
      canonicalId: string,
      aliasId: string,
      aliasNotice?: DeprecationNotice,
    ) => Effect.Effect<void, DeprecationContradictionError>;
  }
>() {}
