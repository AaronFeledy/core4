import { Context, DateTime, Effect, type Option } from "effect";

import type { DeprecatedSurfaceError, DeprecationContradictionError } from "../errors/deprecation.ts";
import type { DeprecationNotice, DeprecationSurfaceKind, DeprecationUse } from "../schema/deprecation.ts";

export type DeprecatedEffectReturn<Return extends Effect.Effect<unknown, unknown, unknown>> =
  Return extends Effect.Effect<infer Success, infer Failure, infer Requirements>
    ? Effect.Effect<Success, Failure | DeprecatedSurfaceError, Requirements>
    : never;

export type DeprecatedCallable<
  Args extends ReadonlyArray<unknown>,
  Return extends Effect.Effect<unknown, unknown, unknown>,
> = ((...args: Args) => DeprecatedEffectReturn<Return>) & {
  readonly deprecation: DeprecationNotice;
};

const nowUtc = () => DateTime.unsafeMake(new Date().toISOString());

export const markDeprecated = <
  Args extends ReadonlyArray<unknown>,
  Return extends Effect.Effect<unknown, unknown, unknown>,
>(
  notice: DeprecationNotice,
  impl: (...args: Args) => Return,
): DeprecatedCallable<Args, Return> => {
  const id = impl.name.length === 0 ? "deprecated-export" : impl.name;
  const deprecated = ((...args: Args): DeprecatedEffectReturn<Return> => {
    const result = impl(...args);
    const recorded = Effect.serviceOption(DeprecationService).pipe(
      Effect.flatMap((deprecations) =>
        deprecations._tag === "None"
          ? Effect.void
          : deprecations.value.use({ kind: "export", id, notice, timestamp: nowUtc() }),
      ),
      Effect.zipRight(result),
    );

    return recorded as DeprecatedEffectReturn<Return>;
  }) as DeprecatedCallable<Args, Return>;

  Object.defineProperty(deprecated, "deprecation", { value: notice, enumerable: true });
  return deprecated;
};

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
