import { Schema } from "effect";

const Remediation = Schema.NonEmptyString.check(Schema.isPattern(/\S/u));

/**
 * Private tagged failure for every source-store operation. Consumers map to
 * domain errors (`LandofileIncludeError`, `RecipeSourceError`,
 * `PluginPackageOperationError`) so user-facing tags stay stable.
 */
export class SourceAcquisitionError extends Schema.TaggedError<SourceAcquisitionError>()(
  "SourceAcquisitionError",
  {
    message: Schema.String,
    source: Schema.String,
    kind: Schema.Literals([
      "invalid-locator",
      "not-found",
      "version-not-found",
      "auth",
      "fetch-failed",
      "integrity-mismatch",
      "integrity-missing",
      "checksum-mismatch",
      "extract-failed",
      "offline-miss",
      "cache",
    ]),
    remediation: Remediation,
    expected: Schema.optionalKey(Schema.String),
    actual: Schema.optionalKey(Schema.String),
    phase: Schema.optionalKey(Schema.Literals(["metadata", "download"])),
  },
) {}

export const displaySource = (source: string): string =>
  source.replace(/(?:[a-z][a-z\d+.-]*:\/\/)[^\s<>"']+/giu, (raw) => {
    try {
      const url = new URL(raw);
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch (cause) {
      if (!(cause instanceof TypeError)) throw cause;
      return raw.replace(/\/\/[^/]*@/u, "//").replace(/[?#].*$/u, "");
    }
  });

const GIT_AUTH_SIGNATURE =
  /Authentication failed|could not read (?:Username|Password)|Permission denied \(publickey|terminal prompts disabled|HTTP Basic: Access denied|returned error: (?:401|403)\b/iu;

const causeKind = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "kind" in cause && typeof cause.kind === "string"
    ? cause.kind
    : undefined;

export const acquisitionError = (
  kind: SourceAcquisitionError["kind"],
  source: string,
  cause: unknown,
): SourceAcquisitionError => {
  if (cause instanceof SourceAcquisitionError)
    return new SourceAcquisitionError({
      kind: cause.kind,
      source: displaySource(cause.source),
      message: displaySource(cause.message),
      remediation: displaySource(cause.remediation),
      ...(cause.expected === undefined ? {} : { expected: displaySource(cause.expected) }),
      ...(cause.actual === undefined ? {} : { actual: displaySource(cause.actual) }),
      ...(cause.phase === undefined ? {} : { phase: cause.phase }),
    });
  const message = cause instanceof Error ? cause.message : String(cause);
  const strippedMessage = displaySource(message);
  const remediation =
    typeof cause === "object" &&
    cause !== null &&
    "remediation" in cause &&
    typeof cause.remediation === "string"
      ? cause.remediation
      : "Check the source coordinates, credentials and cache permissions, then retry.";
  const transportKind = causeKind(cause);
  let mappedKind: SourceAcquisitionError["kind"] = kind;
  let phase: SourceAcquisitionError["phase"];
  if (transportKind === "package-not-found") mappedKind = "not-found";
  else if (transportKind === "version-not-found") mappedKind = "version-not-found";
  else if (Schema.is(SourceAcquisitionError.fields.kind)(transportKind)) mappedKind = transportKind;
  else if (transportKind === "download-failed" || transportKind === "registry-failed") {
    mappedKind = "fetch-failed";
    phase = transportKind === "download-failed" ? "download" : "metadata";
  } else if (
    kind === "fetch-failed" &&
    GIT_AUTH_SIGNATURE.test(message.replace(/[a-z][a-z\d+.-]*:\/\/[^\s<>"']+/giu, ""))
  )
    mappedKind = "auth";

  return new SourceAcquisitionError({
    kind: mappedKind,
    source: displaySource(source),
    message: strippedMessage,
    remediation: displaySource(remediation),
    ...(phase === undefined ? {} : { phase }),
  });
};
