import { mapFailures } from "@lando/sdk/command-result";
import { ArtifactBuildError } from "@lando/sdk/errors";
import type { ServicePlan } from "@lando/sdk/schema";
import { type ArtifactBuildContextTree, ServiceBuildAcquisition } from "@lando/sdk/services";
import type { SourceStore } from "@lando/source-acquisition";
import { Context, Effect, type Option, Predicate, Schema } from "effect";
import { buildStepsFor } from "./build-key.ts";

export class BuildSourceStore extends Context.Service<BuildSourceStore, Pick<SourceStore, "session">>()(
  "@lando/engine/BuildSourceStore",
) {}

export const acquireBuildTrees = Effect.fn("BuildOrchestrator.acquireBuildTrees")(function* (
  service: ServicePlan,
  store: Option.Option<Context.Service.Shape<typeof BuildSourceStore>>,
  context: { readonly providerId: string; readonly redact: (text: string) => string },
) {
  const error = (message: string, remediation: string) =>
    new ArtifactBuildError({
      providerId: context.providerId,
      service: service.name,
      operation: "buildArtifact",
      message: context.redact(message),
      remediation: context.redact(remediation),
    });
  const trees: ArtifactBuildContextTree[] = [];
  const descriptors = buildStepsFor(service).flatMap((step) =>
    Predicate.isObject(step) && step.phase === "build" && step.acquisitions !== undefined
      ? [step.acquisitions]
      : [],
  );
  if (descriptors.length === 0) return trees;
  const acquisitions = (yield* Effect.forEach(descriptors, (descriptor) =>
    Schema.decodeUnknownEffect(Schema.Array(ServiceBuildAcquisition))(descriptor),
  ).pipe(
    mapFailures(() =>
      error("Invalid artifact source acquisition plan.", "Check the service plugin's build inputs."),
    ),
  )).flat();
  const first = acquisitions[0];
  if (first === undefined) return trees;
  if (store._tag === "None") {
    return yield* error(
      "Host build source acquisition is unavailable.",
      "Supply the build source store in the runtime bootstrap.",
    );
  }
  const session = yield* store.value.session.pipe(
    mapFailures((failure) =>
      error(
        `Unable to open build source cache for ${first.name}@${first.version}: ${failure.message}`,
        failure.remediation,
      ),
    ),
  );
  for (const { name, version, integrity, contextName, destination } of acquisitions) {
    const snapshot = yield* session
      .acquireExactNpm({ name, version, ...(integrity === undefined ? {} : { integrity }) })
      .pipe(
        mapFailures((failure) =>
          error(
            `Unable to acquire ${name}@${version} for the build: ${failure.message}`,
            failure.phase !== undefined || failure.kind === "offline-miss"
              ? "Check registry access, proxy, and CA settings. This exact package needs host network access once if it is not cached."
              : failure.remediation,
          ),
        ),
      );
    trees.push({ contextName, destination, root: snapshot.root, digest: snapshot.treeDigest });
  }
  return trees;
});
