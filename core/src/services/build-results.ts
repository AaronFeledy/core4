import { DateTime, Effect, Schema } from "effect";

import type { StateStoreError } from "@lando/sdk/errors";
import { AbsolutePath, ServiceName } from "@lando/sdk/schema";
import type { StateBucket, StateStoreShape } from "@lando/sdk/services";

const BUILD_RESULTS_VERSION = 1;
const KEEP_COMPLETE = 10;
const KEEP_FAIL = 5;

export const BuildResultEntry = Schema.Struct({
  buildKey: Schema.String,
  service: ServiceName,
  phase: Schema.Literal("artifact", "app"),
  outcome: Schema.Literal("complete", "fail"),
  exitCode: Schema.Number,
  durationMs: Schema.Number,
  artifactRef: Schema.optional(Schema.String),
  transcriptPath: AbsolutePath,
  completedAt: Schema.DateTimeUtc,
});
export type BuildResultEntry = typeof BuildResultEntry.Type;

const BuildResultEntries = Schema.Array(BuildResultEntry);

export const openScratchBuildResults = (
  stateStore: StateStoreShape,
): Effect.Effect<StateBucket<ReadonlyArray<BuildResultEntry>>, StateStoreError> =>
  stateStore.open({
    root: "userCache",
    key: "scratch-build-results.bin",
    schema: BuildResultEntries,
    version: BUILD_RESULTS_VERSION,
    codec: "binary",
    lock: "advisory",
    onCorrupt: "quarantine",
    onVersionMismatch: "discard",
    default: [],
  });

export const findCompleteBuildResult = (
  entries: ReadonlyArray<BuildResultEntry>,
  input: Pick<BuildResultEntry, "buildKey" | "phase" | "service">,
): BuildResultEntry | undefined => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry !== undefined &&
      entry.outcome === "complete" &&
      entry.buildKey === input.buildKey &&
      entry.phase === input.phase &&
      entry.service === input.service
    ) {
      return entry;
    }
  }
  return undefined;
};

const matchingOutcome = (left: BuildResultEntry, right: BuildResultEntry): boolean =>
  left.service === right.service &&
  left.phase === right.phase &&
  left.buildKey === right.buildKey &&
  left.outcome === right.outcome;

const limitFor = (outcome: BuildResultEntry["outcome"]): number =>
  outcome === "complete" ? KEEP_COMPLETE : KEEP_FAIL;

const rotateBuildResults = (entries: ReadonlyArray<BuildResultEntry>): ReadonlyArray<BuildResultEntry> =>
  entries.filter((entry, index) => {
    const newerOrSame = entries.slice(index).filter((candidate) => matchingOutcome(candidate, entry));
    return newerOrSame.length <= limitFor(entry.outcome);
  });

export const recordBuildResult = (
  bucket: StateBucket<ReadonlyArray<BuildResultEntry>>,
  entry: Omit<BuildResultEntry, "completedAt">,
): Effect.Effect<void, StateStoreError> =>
  bucket
    .update((current) =>
      rotateBuildResults([
        ...(current ?? []),
        { ...entry, completedAt: DateTime.unsafeMake(new Date().toISOString()) },
      ]),
    )
    .pipe(Effect.asVoid);
