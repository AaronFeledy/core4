import { Schema } from "effect";
import { type LanguageSource, LanguageSourceSchema, languageSource } from "../../language/errors.ts";

const remedies = {
  "invalid-reference":
    "Use a relative contained local path, an owner/repository[/path]@ref, or a Docker image reference without credentials, traversal or URL suffixes.",
  "pin-required":
    "Supply a full immutable 40-character commit or SHA-256 image digest under pin-only policy.",
  "policy-denied": "Explicitly permit the canonical repository origin in the invocation policy.",
  "resolver-required":
    "Supply an independently trusted fixture resolution for this mutable reference; production resolution is unavailable.",
  "origin-mismatch": "Use provenance and expected bytes from the exact canonical repository origin.",
  "offline-miss":
    "Supply verified fixture bytes for this immutable source before requesting an offline cache hit.",
  "integrity-mismatch":
    "Discard the source and supply independently trusted expected identity, size and SHA-256 values matching every file.",
  "source-limit": "Reduce fixture source files to at most 256 KiB each, 8 MiB total and 100 files.",
  "metadata-invalid":
    "Supply valid UTF-8 action or reusable workflow metadata supported by the pinned upstream parser.",
  "cache-failed": "Provide an owner-private SDK StateStore and retry the verified fixture cache operation.",
} as const;
export class ActionSourceError extends Schema.TaggedError<ActionSourceError>()("ActionSourceError", {
  message: Schema.Literal("GitHub Actions source could not be prepared."),
  reason: Schema.Literals(Object.keys(remedies) as [keyof typeof remedies, ...(keyof typeof remedies)[]]),
  source: LanguageSourceSchema,
  remediation: Schema.String,
}) {}
export const sourceError = (reason: keyof typeof remedies, source: LanguageSource) =>
  new ActionSourceError({
    message: "GitHub Actions source could not be prepared.",
    reason,
    source: languageSource(source),
    remediation: remedies[reason],
  });
