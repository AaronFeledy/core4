import { RecipeSourceError, causeMessage } from "@lando/sdk/errors";
import { SourceAcquisitionError, displaySource } from "@lando/source-acquisition";
import { Effect, Schema } from "effect";

type SourceContext = "git" | "archive" | "npm" | "generic";

const recipeKind = (
  kind: SourceAcquisitionError["kind"],
  context: SourceContext,
  phase?: SourceAcquisitionError["phase"],
): RecipeSourceError["kind"] => {
  switch (kind) {
    case "auth":
    case "checksum-mismatch":
    case "extract-failed":
    case "integrity-mismatch":
    case "integrity-missing":
    case "version-not-found":
      return kind;
    case "cache":
    case "offline-miss":
      return "cache";
    case "not-found":
      return context === "npm" ? "package-not-found" : "recipe-not-found";
    case "invalid-locator":
      return context === "npm" ? "missing-package" : context === "git" ? "clone-failed" : "download-failed";
    case "fetch-failed":
      return phase === "metadata"
        ? "registry-failed"
        : context === "git"
          ? "clone-failed"
          : "download-failed";
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
};
export const mapSourceAcquisitionError = (
  cause: unknown,
  context: SourceContext = "generic",
): RecipeSourceError => {
  if (Schema.is(RecipeSourceError)(cause)) return cause;
  if (Schema.is(SourceAcquisitionError)(cause))
    return new RecipeSourceError({
      message: displaySource(cause.message),
      source: displaySource(cause.source),
      kind: recipeKind(cause.kind, context, cause.phase),
      remediation: displaySource(cause.remediation),
    });
  return new RecipeSourceError({
    message: displaySource(causeMessage(cause)),
    source: "sources",
    kind: recipeKind("fetch-failed", context),
    remediation: "Check the recipe source coordinates and retry lando init.",
  });
};
export const runSourceSession = <A>(
  effect: Effect.Effect<A, SourceAcquisitionError>,
  context: SourceContext = "generic",
  signal?: AbortSignal,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(Effect.mapError((error) => mapSourceAcquisitionError(error, context))),
    signal === undefined ? undefined : { signal },
  );
