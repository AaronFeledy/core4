import type { DestroyAppOptions } from "@lando/sdk/app";
import { AppResolveError } from "@lando/sdk/errors";
import { FileSystem } from "@lando/sdk/services";
import { Effect, Result, Schema } from "effect";
import { TeardownProvider } from "../providers/app-placement.ts";
import { UnreadableStartJournal, sweepCompletedAcceleratedStarts } from "./accelerated-start-inventory.ts";
import { digest } from "./accelerated-start-record.ts";
import { withAppMutationLock } from "./app-mutation-lock.ts";
import { destroyAppAtRoot } from "./destroy.ts";
import { MissingAppRoot, MissingRootScan } from "./missing-app-root-schema.ts";
import { scanMissingAppRoots } from "./missing-app-roots.ts";

const RootFailure = Schema.Struct({
  _tag: Schema.String,
  message: Schema.String,
  remediation: Schema.String,
});
const RootOutcome = Schema.Struct({
  root: MissingAppRoot.fields.root,
  providers: MissingAppRoot.fields.providers,
  outcome: Schema.Literals(["destroyed", "unchanged", "failed", "retained"]),
  confirmed: Schema.Boolean,
  reason: Schema.String,
  error: Schema.optionalKey(RootFailure),
});
export const AppsGcReport = Schema.Struct({
  prune: Schema.Boolean,
  candidates: Schema.Array(MissingAppRoot),
  scans: Schema.Array(MissingRootScan),
  roots: Schema.Array(RootOutcome),
  completedJournalsRemoved: Schema.Number,
  unreadableJournals: Schema.Array(UnreadableStartJournal),
});
export type AppsGcReport = typeof AppsGcReport.Type;

export const prepareAppsGc = Effect.fn("AppOperation.prepareAppsGc")(function* (
  options: DestroyAppOptions = {},
) {
  const scan = yield* scanMissingAppRoots().pipe(Effect.provideService(TeardownProvider, options.providerId));
  const report: AppsGcReport = {
    candidates: scan.candidates,
    scans: scan.scans,
    unreadableJournals: scan.unreadableJournals,
    prune: false,
    roots: [],
    completedJournalsRemoved: 0,
  };
  return { report, prune: pruneAppsGc(report, scan.identities, options) };
});

const evidenceDigest = (record: typeof MissingAppRoot.Type) =>
  digest({ ...record, runtimeObserved: undefined });

const pruneAppsGc = Effect.fn("AppOperation.pruneAppsGc")(function* (
  confirmed: AppsGcReport,
  identities: ReadonlyMap<string, string>,
  options: DestroyAppOptions,
) {
  const roots: (typeof RootOutcome.Type)[] = [];
  const fs = yield* FileSystem;
  const sweep = yield* sweepCompletedAcceleratedStarts(options.providerId);
  for (const candidate of confirmed.candidates) {
    const result = yield* withAppMutationLock(
      { id: candidate.apps[0] ?? candidate.root, root: candidate.root, kind: "user" },
      Effect.gen(function* () {
        if (yield* fs.exists(candidate.root))
          return { outcome: "retained" as const, reason: "The app folder exists again." };
        const current = yield* scanMissingAppRoots();
        const failedScan = current.scans.find(
          (scan) => candidate.providers.includes(scan.providerId) && scan.errorTag !== undefined,
        );
        if (failedScan !== undefined)
          return yield* Effect.fail(
            new AppResolveError({
              reason: "mismatch",
              detail: "provider-scan",
              message: failedScan.message,
              remediation:
                failedScan.remediation ?? "Repair the provider scan before retrying apps:gc --prune.",
            }),
          );
        const record = current.candidates.find((record) => record.root === candidate.root);
        if (
          record === undefined &&
          current.scans.some((scan) => candidate.providers.includes(scan.providerId) && !scan.complete)
        )
          return {
            outcome: "retained" as const,
            reason: "A recorded provider was not observed; absence of its resources cannot be verified.",
          };
        if (record === undefined)
          return { outcome: "unchanged" as const, reason: "The recorded leftovers are already absent." };
        if (
          evidenceDigest(candidate) !== evidenceDigest(record) ||
          identities.get(candidate.root) !== current.identities.get(candidate.root)
        )
          return {
            outcome: "retained" as const,
            reason: "Evidence changed after confirmation; run apps:gc again.",
          };
        const destroyed = yield* destroyAppAtRoot(candidate.root, { ...options, yes: true });
        const remaining = yield* scanMissingAppRoots();
        if (remaining.scans.some((scan) => candidate.providers.includes(scan.providerId) && !scan.complete))
          return {
            outcome: "retained" as const,
            reason: "Cleanup ran, but a recorded provider could not be observed to confirm completion.",
          };
        const leftovers = remaining.candidates.find((record) => record.root === candidate.root);
        if (leftovers !== undefined) {
          const blocked =
            leftovers.appliedState ||
            leftovers.services.length > 0 ||
            (options.volumes === true && leftovers.dataVolumes.length > 0) ||
            leftovers.journals.some((journal) => options.volumes === true || journal.targets.length === 0) ||
            (options.purgeCaches === true && leftovers.cacheVolumes.length > 0);
          if (!blocked) {
            const kept = [
              ...(leftovers.dataVolumes.length === 0
                ? []
                : [`data volumes (${leftovers.dataVolumes.join(", ")}) because --volumes was not set`]),
              ...(leftovers.journals.length === 0
                ? []
                : ["file-sync copies and their ownership journals because --volumes was not set"]),
              ...(leftovers.cacheVolumes.length === 0
                ? []
                : [
                    `cache volumes (${leftovers.cacheVolumes.join(", ")}) because --purge-caches was not set`,
                  ]),
            ];
            return {
              outcome: destroyed.outcome ?? "destroyed",
              reason: `Cleanup completed; kept ${kept.join("; ")}.`,
            };
          }
          return {
            outcome: "retained" as const,
            reason:
              "Requested cleanup is incomplete: containers, state, or volumes selected for deletion remain.",
          };
        }
        return { outcome: destroyed.outcome ?? "destroyed", reason: "Cleanup completed." };
      }).pipe(Effect.provideService(TeardownProvider, options.providerId)),
    ).pipe(Effect.result);
    roots.push({
      root: candidate.root,
      providers: candidate.providers,
      confirmed: true,
      ...(Result.isSuccess(result)
        ? result.success
        : {
            outcome: "failed" as const,
            reason: result.failure.message,
            error: {
              _tag: result.failure._tag,
              message: result.failure.message,
              remediation: result.failure.remediation,
            },
          }),
    });
  }
  const finalScan = yield* scanMissingAppRoots().pipe(
    Effect.provideService(TeardownProvider, options.providerId),
  );
  for (const record of finalScan.candidates) {
    if (confirmed.candidates.some((candidate) => candidate.root === record.root)) continue;
    roots.push({
      root: record.root,
      providers: record.providers,
      outcome: "retained",
      confirmed: false,
      reason: "Found after confirmation; not pruned.",
    });
  }
  return {
    ...confirmed,
    prune: true,
    scans: finalScan.scans,
    roots,
    completedJournalsRemoved: sweep.removed,
    unreadableJournals: [
      ...new Map(
        [...confirmed.unreadableJournals, ...sweep.unreadable, ...finalScan.unreadableJournals].map(
          (journal) => [journal.path, journal],
        ),
      ).values(),
    ],
  } satisfies AppsGcReport;
});
