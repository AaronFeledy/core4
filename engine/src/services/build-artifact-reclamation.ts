import { normalizeImageRef } from "@lando/container-runtime/image-list";
import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";
import { type BuiltImageCleanup, ProviderId } from "@lando/sdk/schema";
import { PathsService, RuntimeProviderRegistry, StateStore } from "@lando/sdk/services";
import { Cause, Effect } from "effect";
import { recordCommandWarning } from "../landofile/command-warnings.ts";
import { withBuiltArtifactsLock } from "./build-artifact-lock.ts";
import { BUILT_ARTIFACT_STORE_LABEL, artifactBuildStoreKey } from "./build-artifact-name.ts";
import { artifactClaimIsAlive, openArtifactBuildResults } from "./build-artifact-results.ts";

export const sweepBuiltArtifacts = Effect.fn("BuiltArtifacts.sweep")(function* (
  providerIds: Iterable<string>,
  redactText?: (text: string) => string,
) {
  const result: { removed: number; inUse: Array<BuiltImageCleanup["inUse"][number]> } = {
    removed: 0,
    inUse: [],
  };
  const redact =
    redactText ??
    (yield* Effect.gen(function* () {
      const redactionService = yield* Effect.serviceOption(RedactionService);
      const redactor =
        redactionService._tag === "Some"
          ? yield* redactionService.value.forProfile("secrets")
          : createStandaloneRedactor("secrets");
      return (text: string) => redactor.redactString(text);
    }));
  yield* withBuiltArtifactsLock(
    Effect.gen(function* () {
      const paths = yield* PathsService;
      const storeKey = yield* artifactBuildStoreKey(paths.roots.userCacheRoot);
      const bucket = yield* openArtifactBuildResults(yield* StateStore);
      const index = yield* bucket.get;
      const claims = index?.claims.filter(artifactClaimIsAlive) ?? [];
      const named = new Set(
        [...(index?.results ?? []), ...claims].map((entry) => normalizeImageRef(entry.artifactRef)),
      );
      const bareId = (ref: string) => ref.replace(/^sha256:/u, "");
      const namedIds = new Set([...named].map(bareId));
      const registry = yield* RuntimeProviderRegistry;
      const counted = new Set<string>();
      yield* Effect.forEach(
        new Set(providerIds),
        (id) =>
          Effect.gen(function* () {
            const providerId = ProviderId.make(id);
            const provider = yield* registry.select(providerId);
            const images = yield* provider.listArtifacts({
              labels: { [BUILT_ARTIFACT_STORE_LABEL]: storeKey },
            });
            for (const image of images) {
              const refs = image.refs.map(normalizeImageRef);
              if (
                namedIds.has(bareId(image.id)) ||
                refs.some((ref) => named.has(ref) || !ref.startsWith(`lando-build-${storeKey}-`))
              )
                continue;
              if (refs.length === 0 && claims.length > 0) continue;
              let removed = false;
              let inUse = false;
              for (const ref of refs.length === 0 ? [image.id] : refs) {
                const removal = yield* provider.removeArtifact({
                  providerId,
                  ref,
                  pruneParents: claims.length === 0,
                });
                switch (removal.kind) {
                  case "removed":
                    removed = true;
                    break;
                  case "absent":
                    break;
                  case "in-use":
                    inUse = true;
                    result.inUse.push({
                      ref: redact(ref),
                      containers: removal.containers.map(redact),
                      reason: redact(removal.reason),
                    });
                    break;
                  default:
                    return removal satisfies never;
                }
              }
              if (removed && !inUse && !counted.has(image.id)) {
                counted.add(image.id);
                result.removed += 1;
              }
            }
          }).pipe(
            Effect.catchCause((cause) =>
              recordCommandWarning({
                code: "LANDO_BUILT_IMAGE_CLEANUP_FAILED",
                message: redact(
                  `Built image cleanup failed on provider ${id}: ${Cause.pretty(cause)}. The next build on that provider removes unused images.`,
                ),
                remediation:
                  "Restore access to the provider; the next build on that provider removes unused images.",
                context: { provider: id },
              }),
            ),
          ),
        { concurrency: 1, discard: true },
      );
    }),
  ).pipe(
    Effect.catchCause((cause) =>
      recordCommandWarning({
        code: "LANDO_BUILT_IMAGE_CLEANUP_FAILED",
        message: redact(
          `Built image cleanup could not read or lock the artifact index: ${Cause.pretty(cause)}`,
        ),
        remediation: "Restore access to the build cache and operation lock directory.",
      }),
    ),
  );
  return result;
});
