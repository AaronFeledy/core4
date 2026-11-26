import { Context, DateTime, Effect, type Option } from "effect";

import type { DeprecatedSurfaceError, DeprecationContradictionError } from "../errors/deprecation.ts";
import type { DeprecationNotice, DeprecationSurfaceKind, DeprecationUse } from "../schema/deprecation.ts";

// ==== Fiber-scoped deprecation recorder ====

/** Fiber-scoped recorder of deprecated surfaces used in one invocation. */
export const DeprecationRecorder = Context.Reference<{
  /** Record a deprecated surface use. Only the first use per (kind,id) is kept in `records()`. */
  readonly record: (use: DeprecationUse) => Effect.Effect<void>;
  /** First-use-per-surface list; no count field. Used for machine output (envelope deprecations). */
  readonly records: () => Effect.Effect<ReadonlyArray<DeprecationUse>>;
  /** Invocation-local summary with per-surface use counts. Used for human warning display. */
  readonly summary: () => Effect.Effect<ReadonlyArray<DeprecationSummaryEntry>>;
}>("@lando/core/DeprecationRecorder", {
  defaultValue: () => ({
    record: () => Effect.void,
    records: () => Effect.succeed([]),
    summary: () => Effect.succeed([]),
  }),
});

export type DeprecationRecorderShape = typeof DeprecationRecorder.Service;

/**
 * A fresh recorder for one command invocation. Provide it as `DeprecationRecorder`
 * around the invocation; `records()` lists the surfaces it used (no counts) and
 * `summary()` adds each surface's use count.
 */
export const makeDeprecationRecorder = (): DeprecationRecorderShape => {
  const list: DeprecationUse[] = [];
  const counts = new Map<string, number>();
  return {
    record: (use) =>
      Effect.sync(() => {
        const key = `${use.kind}:${use.id}`;
        const existing = counts.get(key) ?? 0;
        counts.set(key, existing + 1);
        if (existing === 0) list.push(use);
      }),
    records: () => Effect.succeed([...list]),
    summary: () =>
      Effect.succeed(list.map((use) => ({ ...use, count: counts.get(`${use.kind}:${use.id}`) ?? 1 }))),
  };
};

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

export function markDeprecated<
  Args extends ReadonlyArray<unknown>,
  Return extends Effect.Effect<unknown, unknown, unknown>,
>(notice: DeprecationNotice, impl: (...args: Args) => Return): DeprecatedCallable<Args, Return>;
export function markDeprecated<
  Args extends ReadonlyArray<unknown>,
  Return extends Effect.Effect<unknown, unknown, unknown>,
>(
  notice: DeprecationNotice,
  exportId: string,
  impl: (...args: Args) => Return,
): DeprecatedCallable<Args, Return>;
export function markDeprecated<
  Args extends ReadonlyArray<unknown>,
  Return extends Effect.Effect<unknown, unknown, unknown>,
>(
  notice: DeprecationNotice,
  exportIdOrImpl: string | ((...args: Args) => Return),
  maybeImpl?: (...args: Args) => Return,
): DeprecatedCallable<Args, Return> {
  const exportId = typeof exportIdOrImpl === "string" ? exportIdOrImpl : undefined;
  const impl = typeof exportIdOrImpl === "function" ? exportIdOrImpl : maybeImpl;
  if (impl === undefined) throw new TypeError("markDeprecated requires an implementation");
  const id = exportId ?? (impl.name.length === 0 ? "deprecated-export" : impl.name);
  const deprecated = ((...args: Args): DeprecatedEffectReturn<Return> => {
    const result = impl(...args);
    const recorded = Effect.serviceOption(DeprecationService).pipe(
      Effect.flatMap((deprecations) =>
        deprecations._tag === "None"
          ? Effect.void
          : DateTime.now.pipe(
              Effect.flatMap((timestamp) =>
                deprecations.value.use({ kind: "export", id, notice, timestamp }),
              ),
            ),
      ),
      Effect.andThen(result),
    );

    return recorded as DeprecatedEffectReturn<Return>;
  }) as DeprecatedCallable<Args, Return>;

  Object.defineProperty(deprecated, "deprecation", { value: notice, enumerable: true });
  return deprecated;
}

export interface DeprecationSummaryEntry extends DeprecationUse {
  readonly count: number;
}

export type DeprecationRegistrySource = "core" | "plugin" | "schema-walk";

export class DeprecationService extends Context.Service<
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
    /**
     * Claims the right to show a human warning for a deprecated surface.
     * Returns `true` on the first claim (the caller should display the warning),
     * `false` on subsequent calls (already shown). Atomic under concurrency.
     * Suppressed output must not call this.
     */
    readonly claimWarning: (kind: DeprecationSurfaceKind, id: string) => Effect.Effect<boolean>;
  }
>()("@lando/core/DeprecationService") {}
