import { Schema } from "effect";

// ==== Volume removal receipts
// Named-volume removals a teardown actually performed, split by storage class.

const removalCount = Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)));

export const VolumeRemovalCounts = Schema.Struct({
  data: removalCount.annotate({ description: "Number of named data volumes actually removed." }),
  cache: removalCount.annotate({ description: "Number of named cache volumes actually removed." }),
}).annotate({
  description:
    "Named volumes a teardown actually removed, by class; a zero count means nothing of that class was removed, not that cleanup is complete.",
});
export type VolumeRemovalCounts = typeof VolumeRemovalCounts.Type;

export const noVolumesRemoved: VolumeRemovalCounts = Object.freeze({ data: 0, cache: 0 });

export const volumesRemovedAny = (counts: VolumeRemovalCounts): boolean =>
  counts.data > 0 || counts.cache > 0;

export const addVolumeRemovalCounts = (
  left: VolumeRemovalCounts,
  right: VolumeRemovalCounts,
): VolumeRemovalCounts => ({ data: left.data + right.data, cache: left.cache + right.cache });
