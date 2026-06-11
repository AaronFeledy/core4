import { type Context, Effect, Layer, Option, Ref } from "effect";

import { DeprecatedSurfaceError, DeprecationContradictionError } from "@lando/sdk/errors";
import type { DeprecationNotice, DeprecationSurfaceKind, DeprecationUse } from "@lando/sdk/schema";
import { DeprecationService, type DeprecationSummaryEntry } from "@lando/sdk/services";

type DeprecationKey = `${DeprecationSurfaceKind}:${string}`;

interface DeprecationUseRecord {
  readonly use: DeprecationUse;
  readonly count: number;
}

interface DeprecationState {
  readonly registry: ReadonlyMap<DeprecationKey, DeprecationNotice>;
  readonly uses: ReadonlyMap<DeprecationKey, DeprecationUseRecord>;
}

const deprecationKey = (kind: DeprecationSurfaceKind, id: string): DeprecationKey => `${kind}:${id}`;

const makeDeprecationService = (
  state: Ref.Ref<DeprecationState>,
): Context.Tag.Service<typeof DeprecationService> => ({
  use: (use) =>
    Ref.update(state, (current) => {
      const key = deprecationKey(use.kind, use.id);
      const existing = current.uses.get(key);
      const uses = new Map(current.uses);
      uses.set(key, {
        use: existing?.use ?? use,
        count: (existing?.count ?? 0) + 1,
      });
      return { ...current, uses };
    }).pipe(
      Effect.flatMap(() =>
        use.notice.severity === "error"
          ? Effect.fail(new DeprecatedSurfaceError({ kind: use.kind, id: use.id, notice: use.notice }))
          : Effect.void,
      ),
    ),
  summary: () =>
    Ref.get(state).pipe(
      Effect.map((current) =>
        [...current.uses.values()].map(
          (record): DeprecationSummaryEntry => ({ ...record.use, count: record.count }),
        ),
      ),
    ),
  lookup: (kind, id) =>
    Ref.get(state).pipe(
      Effect.map((current) => Option.fromNullable(current.registry.get(deprecationKey(kind, id)))),
    ),
  register: (_source, kind, id, notice) =>
    Ref.update(state, (current) => {
      const registry = new Map(current.registry);
      registry.set(deprecationKey(kind, id), notice);
      return { ...current, registry };
    }),
  registerAlias: (_source, kind, canonicalId, aliasId, aliasNotice) =>
    Ref.get(state).pipe(
      Effect.flatMap((current) => {
        const canonicalNotice = current.registry.get(deprecationKey(kind, canonicalId));
        if (canonicalNotice !== undefined && aliasNotice === undefined) {
          return Effect.fail(new DeprecationContradictionError({ canonicalId, aliasId, canonicalNotice }));
        }
        if (aliasNotice === undefined) return Effect.void;
        return Ref.update(state, (latest) => {
          const registry = new Map(latest.registry);
          registry.set(deprecationKey(kind, aliasId), aliasNotice);
          return { ...latest, registry };
        });
      }),
    ),
});

export const DeprecationServiceLive = Layer.effect(
  DeprecationService,
  Ref.make<DeprecationState>({ registry: new Map(), uses: new Map() }).pipe(
    Effect.map(makeDeprecationService),
  ),
);
