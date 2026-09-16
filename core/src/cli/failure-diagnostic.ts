import { Schema } from "effect";

const FAILURE_TAGS = [
  "ProviderUnavailableError",
  "ProviderInternalError",
  "ContainerTransportError",
] as const;
const PROVIDER_IDS = ["lando", "docker", "podman"] as const;
const OPERATIONS = ["pullArtifact", "podman-api", "docker-api", "container-transport"] as const;
const TRANSPORT_KINDS = ["connect", "write", "parse", "http"] as const;
const HTTP_METHODS = ["GET", "POST", "PUT", "DELETE"] as const;
const PULL_FAILURE_KINDS = ["registry-auth", "generic"] as const;
const MAX_CAUSE_DEPTH = 8;

const HttpStatusSchema = Schema.Int.pipe(Schema.between(100, 599));
const FailureCauseEvidenceSchema = Schema.Struct({
  _tag: Schema.optional(Schema.Literal(...FAILURE_TAGS)),
  name: Schema.optional(Schema.Literal(...FAILURE_TAGS)),
  providerId: Schema.optional(Schema.Literal(...PROVIDER_IDS)),
  operation: Schema.optional(Schema.Literal(...OPERATIONS)),
  kind: Schema.optional(Schema.Literal(...TRANSPORT_KINDS)),
  details: Schema.optional(
    Schema.Struct({
      status: Schema.optional(HttpStatusSchema),
      method: Schema.optional(Schema.Literal(...HTTP_METHODS)),
      failureKind: Schema.optional(Schema.Literal(...PULL_FAILURE_KINDS)),
    }),
  ),
});

export const ImagePullFailureDiagnosticSchema = Schema.Struct({
  domain: Schema.Literal("image-pull"),
  failureKind: Schema.Literal(...PULL_FAILURE_KINDS),
  httpStatus: Schema.optional(HttpStatusSchema),
  transportKind: Schema.optional(Schema.Literal(...TRANSPORT_KINDS)),
});

export const FailureEvidenceSchema = Schema.Struct({
  causes: Schema.Array(FailureCauseEvidenceSchema).pipe(Schema.maxItems(MAX_CAUSE_DEPTH)),
  imagePull: Schema.optional(ImagePullFailureDiagnosticSchema),
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
  let imagePull = false;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) break;
    const tag = closedLiteral(current, "_tag", FAILURE_TAGS);
    const name = closedLiteral(current, "name", FAILURE_TAGS);
    const providerId = closedLiteral(current, "providerId", PROVIDER_IDS);
    const operation = closedLiteral(current, "operation", OPERATIONS);
    const kind = closedLiteral(current, "kind", TRANSPORT_KINDS);
    const details = Reflect.get(current, "details");
    const method =
      typeof details === "object" && details !== null
        ? closedLiteral(details, "method", HTTP_METHODS)
        : undefined;
    const failureKind =
      typeof details === "object" && details !== null
        ? closedLiteral(details, "failureKind", PULL_FAILURE_KINDS)
        : undefined;
    const status = typeof details === "object" && details !== null ? nestedHttpStatus(details) : undefined;

    causes.push({
      ...(tag === undefined ? {} : { _tag: tag }),
      ...(name === undefined ? {} : { name }),
      ...(providerId === undefined ? {} : { providerId }),
      ...(operation === undefined ? {} : { operation }),
      ...(kind === undefined ? {} : { kind }),
      ...(method === undefined && failureKind === undefined && status === undefined
        ? {}
        : {
            details: {
              ...(status === undefined ? {} : { status }),
              ...(method === undefined ? {} : { method }),
              ...(failureKind === undefined ? {} : { failureKind }),
            },
          }),
    });
    if (operation === "pullArtifact") imagePull = true;
    pullFailureKind ??= failureKind;
    pullHttpStatus ??= status;
    if (tag === "ContainerTransportError" || name === "ContainerTransportError") {
      pullTransportKind ??= kind;
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
            ...(pullTransportKind === undefined ? {} : { transportKind: pullTransportKind }),
          },
        }
      : {}),
  };
};
