import { AppFeatureMutationConflictError } from "@lando/sdk/errors";
import { type ServiceConfig, canonicalImageReference, sameImageReference } from "@lando/sdk/schema";
import type { AppFeatureServiceView } from "@lando/sdk/services";
import { Effect, Result, Schema } from "effect";
import { type PhpVia, phpImageFor } from "./php-via.ts";

export const PHP_RUNTIME_POLICY_KEY = "@lando/service-lando/php-runtime-policy";
export const PhpBaseFamily = Schema.Literals(["debian-bookworm", "debian-bullseye"]);
export type PhpBaseFamily = typeof PhpBaseFamily.Type;

const BaseFamilyEvidence = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("known"),
    family: PhpBaseFamily,
    evidence: Schema.Literals(["stock", "canonical-reference"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("unknown"),
    reason: Schema.Literals(["replacement-build", "unproven-image-family"]),
  }),
]);

export const PhpRuntimePolicy = Schema.Struct({
  artifactSource: Schema.Literals(["stock", "image", "context-build"]),
  processAuthority: Schema.Literals(["lando", "authored", "image-default"]),
  baseFamily: BaseFamilyEvidence,
  reference: Schema.optionalKey(Schema.String),
  logMode: Schema.Literals(["apache-console", "fpm-shared-stderr", "console-only"]),
});
export type PhpRuntimePolicy = typeof PhpRuntimePolicy.Type;

/** Resolve ownership once; the catalog image may already be stamped on this config. */
export const resolvePhpRuntimePolicy = (
  service: ServiceConfig,
  version: string,
  via: PhpVia,
): PhpRuntimePolicy => {
  const artifactSource =
    service.build !== undefined && "context" in service.build
      ? "context-build"
      : service.image === undefined || sameImageReference(service.image, phpImageFor(version, "apache"))
        ? "stock"
        : "image";
  const processAuthority =
    service.command !== undefined || service.entrypoint !== undefined
      ? "authored"
      : artifactSource === "stock"
        ? "lando"
        : "image-default";
  const reference =
    artifactSource === "stock"
      ? phpImageFor(version, via)
      : artifactSource === "image"
        ? service.image
        : undefined;
  const suite =
    reference === undefined
      ? undefined
      : /^docker\.io\/library\/php:[A-Za-z0-9][A-Za-z0-9._-]*-(bookworm|bullseye)$/u.exec(
          canonicalImageReference(reference),
        )?.[1];
  const baseFamily: typeof BaseFamilyEvidence.Type =
    artifactSource === "context-build"
      ? { kind: "unknown", reason: "replacement-build" }
      : artifactSource === "stock"
        ? { kind: "known", family: "debian-bookworm", evidence: "stock" }
        : suite === undefined
          ? { kind: "unknown", reason: "unproven-image-family" }
          : {
              kind: "known",
              family: suite === "bullseye" ? "debian-bullseye" : "debian-bookworm",
              evidence: "canonical-reference",
            };
  return Object.freeze({
    artifactSource,
    processAuthority,
    baseFamily: Object.freeze(baseFamily),
    ...(reference === undefined ? {} : { reference }),
    logMode:
      processAuthority !== "lando" || via === "cli"
        ? "console-only"
        : via === "apache"
          ? "apache-console"
          : "fpm-shared-stderr",
  });
};

/** Selected PHP services must carry the resolver's facts, never reconstruct them from config. */
export const readPhpRuntimePolicy = (
  service: AppFeatureServiceView,
  feature: string,
): Effect.Effect<PhpRuntimePolicy, AppFeatureMutationConflictError> => {
  const parsed = Schema.decodeUnknownResult(PhpRuntimePolicy)(
    service.resolutionMetadata?.[PHP_RUNTIME_POLICY_KEY],
    { onExcessProperty: "error" },
  );
  if (Result.isSuccess(parsed)) return Effect.succeed(parsed.success);
  return Effect.fail(
    new AppFeatureMutationConflictError({
      feature,
      service: service.serviceName,
      field: "resolutionMetadata",
      message: "Selected PHP service has missing or invalid resolved runtime policy.",
      remediation:
        "Resolve the PHP service type before applying app features; preserve its resolution metadata.",
    }),
  );
};
