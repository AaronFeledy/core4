import { Context, Effect, Schema } from "effect";

import { GlobalAppError, StateStoreError } from "@lando/sdk/errors";
import { StateStore } from "@lando/sdk/services";

import type { PendingGlobalServiceContribution } from "../services/global-services.ts";

const GlobalEnablement = Schema.Record(Schema.String, Schema.Boolean);

const enablementError = (cause: StateStoreError): GlobalAppError =>
  new GlobalAppError({
    message: "Unable to read or update global service enablement.",
    operation: "enablement",
    cause,
    remediation: `Repair the permissions or boolean contribution entries in ${cause.path ?? "global.config.yml"}, then retry.`,
  });

export const globalEnablementBucket = Effect.fn("GlobalApp.enablementBucket")(function* () {
  const store = yield* StateStore;
  return yield* store
    .open({
      root: "userConf",
      key: "global.config.yml",
      schema: GlobalEnablement,
      version: 1,
      codec: {
        encode: (value) => Bun.YAML.stringify(value),
        decode: (raw) =>
          Schema.decodeUnknownSync(GlobalEnablement)(Bun.YAML.parse(new TextDecoder().decode(raw))),
      },
      lock: "advisory",
      onCorrupt: "fail",
      default: {},
    })
    .pipe(Effect.mapError(enablementError));
});

export const readGlobalEnablement = Effect.fn("GlobalApp.readEnablement")(function* () {
  const bucket = yield* globalEnablementBucket();
  return (yield* bucket.get.pipe(Effect.mapError(enablementError))) ?? {};
});

export const globalContributionEnabled = (
  entry: PendingGlobalServiceContribution,
  enablement: Readonly<Record<string, boolean>>,
): boolean =>
  Object.hasOwn(enablement, entry.contribution.id)
    ? enablement[entry.contribution.id] === true
    : entry.contribution.enabledByDefault !== false;

export const seedGlobalEnablement = Effect.fn("GlobalApp.seedEnablement")(function* (
  contributions: ReadonlyArray<PendingGlobalServiceContribution>,
  selection?: { readonly ids: ReadonlyArray<string>; readonly enabled: boolean },
) {
  const bucket = yield* globalEnablementBucket();
  return yield* bucket
    .update((current) => {
      const entries = new Map(Object.entries(current ?? {}));
      for (const { contribution } of contributions) {
        if (!entries.has(contribution.id))
          entries.set(contribution.id, contribution.enabledByDefault !== false);
      }
      for (const id of selection?.ids ?? []) entries.set(id, selection?.enabled === true);
      return Object.fromEntries(entries);
    })
    .pipe(Effect.mapError(enablementError));
});

export const selectGlobalContributions = (
  contributions: ReadonlyArray<PendingGlobalServiceContribution>,
  selector?: string,
): Effect.Effect<ReadonlyArray<PendingGlobalServiceContribution>, GlobalAppError> => {
  if (selector === undefined) return Effect.succeed(contributions);
  const packageMatches = contributions.filter((entry) => entry.plugin === selector);
  const idMatches = contributions.filter((entry) => entry.contribution.id === selector);
  if (
    packageMatches.length > 0 &&
    idMatches.length > 0 &&
    (packageMatches.length !== idMatches.length || packageMatches.some((entry) => !idMatches.includes(entry)))
  ) {
    return Effect.fail(
      new GlobalAppError({
        message: `Global service selection ${selector} matches both a plugin and a different contribution.`,
        operation: "enablement",
        remediation: "Choose an unambiguous plugin package name or global service contribution id.",
      }),
    );
  }
  const selected = packageMatches.length > 0 ? packageMatches : idMatches;
  if (selected.length > 0) return Effect.succeed(selected);
  return Effect.fail(
    new GlobalAppError({
      message: `No global service contribution or plugin matches ${selector}.`,
      operation: "enablement",
      remediation: "Run `lando global:list` and choose a listed contribution id or plugin package name.",
    }),
  );
};

const HeldGlobalMutationKeys = Context.Reference<ReadonlySet<string>>(
  "@lando/engine/HeldGlobalMutationKeys",
  {
    defaultValue: () => new Set(),
  },
);

/** Serialize reconciliation and runtime apply; nested operations reuse their caller's lock. */
export const withGlobalMutation = Effect.fnUntraced(function* <A, E, R>(body: Effect.Effect<A, E, R>) {
  const store = yield* StateStore;
  const key = "global-app";
  const held = yield* HeldGlobalMutationKeys;
  if (held.has(key)) return yield* body;
  const context = yield* Effect.context<R>();
  const provided = body.pipe(
    Effect.provideService(HeldGlobalMutationKeys, new Set([...held, key])),
    Effect.provide(context),
  );
  // Operation locks live in userData. The bucket's own advisory update also serializes
  // shared userConf maps when different data roots use the same configuration root.
  return yield* store
    .withLock(key, provided)
    .pipe(Effect.mapError((cause) => (cause instanceof StateStoreError ? enablementError(cause) : cause)));
});
