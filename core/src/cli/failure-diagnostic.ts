import { Schema } from "effect";

const FAILURE_TAGS = [
  "ProviderUnavailableError",
  "ProviderInternalError",
  "ContainerTransportError",
] as const;
const PROVIDER_IDS = ["lando", "docker", "podman"] as const;
const OPERATIONS = ["pullArtifact", "podman-api", "docker-api", "container-transport"] as const;
const TRANSPORT_KINDS = ["connect", "write", "read", "parse", "http"] as const;
const TRANSPORT_SYSTEM_CODES = ["ECONNABORTED", "ECONNRESET", "EPIPE", "ETIMEDOUT"] as const;
const HTTP_METHODS = ["GET", "POST", "PUT", "DELETE"] as const;
const PULL_FAILURE_KINDS = ["registry-auth", "generic"] as const;
const PULL_FAILURE_SOURCES = ["stream-frame"] as const;
const PULL_FAILURE_SIGNATURES = [
  "toomanyrequests",
  "denied",
  "manifest-unknown",
  "name-unknown",
  "no-such-host",
  "connection-refused",
  "timeout",
  "tls",
  "unknown",
] as const;
const MAX_CAUSE_DEPTH = 8;

const HttpStatusSchema = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 100, maximum: 599 })));
const FailureCauseEvidenceSchema = Schema.Struct({
  _tag: Schema.optionalKey(Schema.Literals([...FAILURE_TAGS])),
  name: Schema.optionalKey(Schema.Literals([...FAILURE_TAGS])),
  providerId: Schema.optionalKey(Schema.Literals([...PROVIDER_IDS])),
  operation: Schema.optionalKey(Schema.Literals([...OPERATIONS])),
  kind: Schema.optionalKey(Schema.Literals([...TRANSPORT_KINDS])),
  systemCode: Schema.optionalKey(Schema.Literals([...TRANSPORT_SYSTEM_CODES])),
  details: Schema.optionalKey(Schema.Struct({
      status: Schema.optionalKey(HttpStatusSchema),
      method: Schema.optionalKey(Schema.Literals([...HTTP_METHODS])),
      failureKind: Schema.optionalKey(Schema.Literals([...PULL_FAILURE_KINDS])),
      source: Schema.optionalKey(Schema.Literals([...PULL_FAILURE_SOURCES])),
      signature: Schema.optionalKey(Schema.Literals([...PULL_FAILURE_SIGNATURES])),
    })),
});

export const ImagePullFailureDiagnosticSchema = Schema.Struct({
  domain: Schema.Literal("image-pull"),
  failureKind: Schema.Literals([...PULL_FAILURE_KINDS]),
  httpStatus: Schema.optionalKey(HttpStatusSchema),
  transportKind: Schema.optionalKey(Schema.Literals([...TRANSPORT_KINDS])),
  systemCode: Schema.optionalKey(Schema.Literals([...TRANSPORT_SYSTEM_CODES])),
  source: Schema.optionalKey(Schema.Literals([...PULL_FAILURE_SOURCES])),
  signature: Schema.optionalKey(Schema.Literals([...PULL_FAILURE_SIGNATURES])),
});

export const FailureEvidenceSchema = Schema.Struct({
  causes: Schema.Array(FailureCauseEvidenceSchema).pipe(Schema.check(Schema.isMaxLength(MAX_CAUSE_DEPTH))),
  imagePull: Schema.optionalKey(ImagePullFailureDiagnosticSchema),
});

export type FailureEvidence = typeof FailureEvidenceSchema.Type;
export type ImagePullFailureDiagnostic = typeof ImagePullFailureDiagnosticSchema.Type;

export const FAILURE_EVIDENCE_PREFIX = "failure-cause-evidence ";

const closedLiteral = <Values extends readonly string[]>(
  value: object,
  key: string,
  allowed: Values,
): Values[number] | undefined => {
  const field = Reflect.get(value, key);
  return typeof field === "string" ? allowed.find((candidate) => candidate === field) : undefined;
};

const httpStatus = (value: object): number | undefined => {
  const status = Reflect.get(value, "status");
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined;
};

const nestedHttpStatus = (details: object): number | undefined => {
  const direct = httpStatus(details);
  if (direct !== undefined) return direct;
  const nested = Reflect.get(details, "details");
  return typeof nested === "object" && nested !== null ? httpStatus(nested) : undefined;
};

export const failureEvidenceFor = (error: unknown): FailureEvidence => {
  const causes: Array<FailureEvidence["causes"][number]> = [];
  let current = error;
  let pullFailureKind: ImagePullFailureDiagnostic["failureKind"] | undefined;
  let pullHttpStatus: number | undefined;
  let pullTransportKind: ImagePullFailureDiagnostic["transportKind"] | undefined;
  let pullSystemCode: ImagePullFailureDiagnostic["systemCode"] | undefined;
  let pullSource: ImagePullFailureDiagnostic["source"] | undefined;
  let pullSignature: ImagePullFailureDiagnostic["signature"] | undefined;
  let imagePull = false;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) break;
    const tag = closedLiteral(current, "_tag", FAILURE_TAGS);
    const name = closedLiteral(current, "name", FAILURE_TAGS);
    const providerId = closedLiteral(current, "providerId", PROVIDER_IDS);
    const operation = closedLiteral(current, "operation", OPERATIONS);
    const kind = closedLiteral(current, "kind", TRANSPORT_KINDS);
    const systemCode = closedLiteral(current, "systemCode", TRANSPORT_SYSTEM_CODES);
    const details = Reflect.get(current, "details");
    const method =
      typeof details === "object" && details !== null
        ? closedLiteral(details, "method", HTTP_METHODS)
        : undefined;
    const failureKind =
      typeof details === "object" && details !== null
        ? closedLiteral(details, "failureKind", PULL_FAILURE_KINDS)
        : undefined;
    const source =
      typeof details === "object" && details !== null
        ? closedLiteral(details, "source", PULL_FAILURE_SOURCES)
        : undefined;
    const signature =
      typeof details === "object" && details !== null
        ? closedLiteral(details, "signature", PULL_FAILURE_SIGNATURES)
        : undefined;
    const status = typeof details === "object" && details !== null ? nestedHttpStatus(details) : undefined;

    causes.push({
      ...(tag === undefined ? {} : { _tag: tag }),
      ...(name === undefined ? {} : { name }),
      ...(providerId === undefined ? {} : { providerId }),
      ...(operation === undefined ? {} : { operation }),
      ...(kind === undefined ? {} : { kind }),
      ...(systemCode === undefined ? {} : { systemCode }),
      ...(method === undefined &&
      failureKind === undefined &&
      status === undefined &&
      source === undefined &&
      signature === undefined
        ? {}
        : {
            details: {
              ...(status === undefined ? {} : { status }),
              ...(method === undefined ? {} : { method }),
              ...(failureKind === undefined ? {} : { failureKind }),
              ...(source === undefined ? {} : { source }),
              ...(signature === undefined ? {} : { signature }),
            },
          }),
    });
    if (operation === "pullArtifact") imagePull = true;
    pullFailureKind ??= failureKind;
    pullHttpStatus ??= status;
    pullSource ??= source;
    pullSignature ??= signature;
    if (tag === "ContainerTransportError" || name === "ContainerTransportError") {
      pullTransportKind ??= kind;
      pullSystemCode ??= systemCode;
    }
    current = Reflect.get(current, "cause");
  }

  return {
    causes,
    ...(imagePull && pullFailureKind !== undefined
      ? {
          imagePull: {
            domain: "image-pull" as const,
            failureKind: pullFailureKind,
            ...(pullHttpStatus === undefined ? {} : { httpStatus: pullHttpStatus }),
            ...(pullSource === undefined ? {} : { source: pullSource }),
            ...(pullSignature === undefined ? {} : { signature: pullSignature }),
            ...(pullTransportKind === undefined ? {} : { transportKind: pullTransportKind }),
            ...(pullSystemCode === undefined ? {} : { systemCode: pullSystemCode }),
          },
        }
      : {}),
  };
};
