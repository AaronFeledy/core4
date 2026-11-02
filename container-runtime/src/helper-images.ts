import { providerImages } from "./generated/provider-images.ts";

/**
 * A helper image the data plane runs only by pinned digest reference. The
 * `ref` is `<image>@<digest>`; acquisition must report `digest` before the
 * helper container is created.
 */
export interface PinnedHelperImage {
  readonly ref: string;
  readonly digest: string;
}

const pinnedHelperImage = (entry: {
  readonly image: string;
  readonly digest: string;
}): PinnedHelperImage => ({
  ref: `${entry.image}@${entry.digest}`,
  digest: entry.digest,
});

/** Shell helper for native snapshot commits and DataMover volume transfers. */
export const dataHelperImage: PinnedHelperImage = pinnedHelperImage(providerImages.images.dataHelper);

/** Bun helper for the volume-ownership witness and the Windows file-sync target. */
export const volumeWitnessImage: PinnedHelperImage = pinnedHelperImage(providerImages.images.volumeWitness);
