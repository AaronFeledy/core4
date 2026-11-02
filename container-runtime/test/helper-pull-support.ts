import { Effect } from "effect";

import type { PulledImage } from "@lando/container-runtime/image-pull";

/**
 * A `pullHelperImage` stub for tests that exercise helper containers but not
 * helper acquisition: it reports the digest a digest-qualified ref names, as a
 * provider that already holds the pinned image would.
 */
export const echoHelperPull =
  (refs: string[] = []) =>
  (ref: string): Effect.Effect<PulledImage> =>
    Effect.sync(() => {
      refs.push(ref);
      const at = ref.indexOf("@");
      return at === -1 ? { ref } : { ref, digest: ref.slice(at + 1) };
    });
