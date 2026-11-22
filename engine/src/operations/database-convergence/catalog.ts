import { type AppPlan, type ServicePlan, sameImageReference } from "@lando/sdk/schema";
import { StateStore } from "@lando/sdk/services";
import { Effect } from "effect";
import { openArtifactBuildResults } from "../../services/build-artifact-results.ts";
import { BuildOwner } from "../../services/build-owner.ts";
import { catalogMount } from "./target.ts";

export const catalogDatabaseKey = "@lando/core/catalog-database";

export const catalogDatabase = Effect.fnUntraced(function* (input: {
  readonly plan: AppPlan;
  readonly service: ServicePlan;
  readonly expectedSource?: { readonly ref: string; readonly digest?: string };
}) {
  const { plan, service, expectedSource } = input;
  const source = service.extensions[catalogDatabaseKey];
  const artifact = service.artifact;
  const mount = catalogMount(plan, service);
  if (typeof source !== "string" || artifact?.kind !== "ref" || mount === undefined) return undefined;
  if (expectedSource !== undefined && !sameImageReference(source, expectedSource.ref)) return undefined;
  if (artifact.origin !== "build")
    return sameImageReference(source, artifact.ref) &&
      (expectedSource?.digest === undefined || expectedSource.digest === artifact.digest)
      ? mount
      : undefined;
  const store = yield* StateStore;
  const index = yield* openArtifactBuildResults(store, "observe");
  const receipts = yield* index.get;
  const owner = BuildOwner.fromPlan(plan).key;
  return receipts?.results.some(
    (receipt) =>
      receipt.outcome === "complete" &&
      receipt.releasedAt === undefined &&
      receipt.artifactOrigin === "build" &&
      receipt.owner === owner &&
      receipt.providerId === plan.provider &&
      receipt.service === service.name &&
      receipt.artifactRef === artifact.ref &&
      receipt.artifactDigest === artifact.digest &&
      receipt.sourceArtifactRef !== undefined &&
      sameImageReference(source, receipt.sourceArtifactRef) &&
      (expectedSource?.digest === undefined || expectedSource.digest === receipt.sourceArtifactDigest),
  ) === true
    ? mount
    : undefined;
});
