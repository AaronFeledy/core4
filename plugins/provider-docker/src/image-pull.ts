import { Effect } from "effect";

import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";

import { redactDetails, redactString } from "./redact.ts";

const PROVIDER_ID = "docker";

export const PULL_REMEDIATION =
  "Run `lando doctor --provider=docker` to inspect the Docker provider, then retry `lando start`.";

export interface ImagePullHttpRequest {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: `/${string}`;
  readonly body?: unknown;
}

export interface ImagePullHttpResponse {
  readonly status: number;
  readonly body: string;
}

export interface ImagePullApi {
  readonly request?: (
    request: ImagePullHttpRequest,
  ) => Effect.Effect<ImagePullHttpResponse, ProviderUnavailableError | ProviderInternalError>;
}

export interface ParsedImageReference {
  readonly fromImage: string;
  readonly tag: string;
}

const splitNameAndTag = (reference: string): ParsedImageReference => {
  const lastSlash = reference.lastIndexOf("/");
  const lastColon = reference.lastIndexOf(":");
  if (lastColon > lastSlash) {
    return { fromImage: reference.slice(0, lastColon), tag: reference.slice(lastColon + 1) };
  }
  return { fromImage: reference, tag: "latest" };
};

/**
 * Split a Docker image reference into Engine `fromImage` + `tag` query values.
 * `name:tag@digest` drops the tag so `fromImage` is the name and `tag` is the digest.
 * Untagged names default to `latest` so `/images/create` does not pull every tag.
 */
export const parseImageReference = (reference: string): ParsedImageReference => {
  const digestAt = reference.lastIndexOf("@");
  if (digestAt !== -1) {
    const { fromImage } = splitNameAndTag(reference.slice(0, digestAt));
    return { fromImage, tag: reference.slice(digestAt + 1) };
  }
  return splitNameAndTag(reference);
};

export const buildImagePullRequest = (reference: string): ImagePullHttpRequest => {
  const { fromImage, tag } = parseImageReference(reference);
  return {
    method: "POST",
    path: `/images/create?fromImage=${encodeURIComponent(fromImage)}&tag=${encodeURIComponent(tag)}`,
  };
};

export const buildImageInspectRequest = (reference: string): ImagePullHttpRequest => ({
  method: "GET",
  path: `/images/${encodeURIComponent(reference)}/json`,
});

export type ImagePullFrame =
  | {
      readonly kind: "progress";
      readonly stream?: string;
      readonly current?: number;
      readonly total?: number;
    }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ignore" };

const textOrUndefined = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const numberOrUndefined = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const progressDetailNumber = (detail: unknown, key: "current" | "total"): number | undefined =>
  typeof detail === "object" && detail !== null
    ? numberOrUndefined((detail as Record<string, unknown>)[key])
    : undefined;

const errorDetailMessage = (detail: unknown): string | undefined => {
  if (typeof detail === "string" && detail.length > 0) return detail;
  if (typeof detail === "object" && detail !== null) {
    return textOrUndefined((detail as Record<string, unknown>).message);
  }
  return undefined;
};

/**
 * Parse a single Docker Engine `/images/create` NDJSON frame. HTTP 200 can
 * still carry `error` / `errorDetail`; those are pull failures.
 */
export const parseImagePullFrame = (line: string): ImagePullFrame => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { kind: "ignore" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: "ignore" };
  }
  if (typeof parsed !== "object" || parsed === null) return { kind: "ignore" };
  const frame = parsed as Record<string, unknown>;
  const errorText = errorDetailMessage(frame.errorDetail) ?? textOrUndefined(frame.error);
  if (errorText !== undefined) return { kind: "error", message: errorText };
  const streamText = textOrUndefined(frame.stream) ?? textOrUndefined(frame.status);
  const current = progressDetailNumber(frame.progressDetail, "current");
  const total = progressDetailNumber(frame.progressDetail, "total");
  if (streamText === undefined && current === undefined && total === undefined) {
    return { kind: "ignore" };
  }
  return {
    kind: "progress",
    ...(streamText === undefined ? {} : { stream: streamText }),
    ...(current === undefined ? {} : { current }),
    ...(total === undefined ? {} : { total }),
  };
};

const missingApi = (): ProviderUnavailableError =>
  new ProviderUnavailableError({
    providerId: PROVIDER_ID,
    operation: "pullArtifact",
    message: "provider-docker pullArtifact requires a Docker API client.",
    remediation: PULL_REMEDIATION,
  });

const pullFailure = (reference: string, message: string, details?: unknown): ProviderUnavailableError =>
  new ProviderUnavailableError({
    providerId: PROVIDER_ID,
    operation: "pullArtifact",
    message: redactString(`Docker image pull failed: ${message}`),
    details: redactDetails({ reference, error: message, ...(details === undefined ? {} : { details }) }),
    remediation: PULL_REMEDIATION,
  });

const send = (
  api: ImagePullApi,
  input: ImagePullHttpRequest,
): Effect.Effect<ImagePullHttpResponse, ProviderUnavailableError | ProviderInternalError> =>
  api.request === undefined ? Effect.fail(missingApi()) : api.request(input);

const digestFromInspectBody = (body: unknown): string | undefined => {
  if (typeof body !== "object" || body === null || !("RepoDigests" in body)) return undefined;
  const digests = (body as { RepoDigests?: unknown }).RepoDigests;
  if (!Array.isArray(digests) || digests.length === 0 || typeof digests[0] !== "string") return undefined;
  const digest = digests[0].split("@")[1];
  return digest === undefined || digest.length === 0 ? undefined : digest;
};

export interface PulledImage {
  readonly ref: string;
  readonly digest?: string;
}

/**
 * Pull `reference` through Docker Engine `POST /images/create`. The buffered
 * response is NDJSON; in-stream `error` / `errorDetail` frames are failures
 * even when HTTP status is 200.
 */
export const pullImage = (
  api: ImagePullApi,
  reference: string,
): Effect.Effect<PulledImage, ProviderUnavailableError | ProviderInternalError> =>
  Effect.gen(function* () {
    const response = yield* send(api, buildImagePullRequest(reference));
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(pullFailure(reference, `HTTP ${response.status}.`, response));
    }

    for (const line of response.body.split("\n")) {
      const frame = parseImagePullFrame(line);
      if (frame.kind === "error") {
        return yield* Effect.fail(pullFailure(reference, frame.message, { body: response.body }));
      }
    }

    const inspectResponse = yield* send(api, buildImageInspectRequest(reference));
    if (inspectResponse.status !== 200) {
      return yield* Effect.fail(
        pullFailure(reference, `post-pull inspect HTTP ${inspectResponse.status}.`, inspectResponse),
      );
    }

    let inspectBody: unknown;
    try {
      inspectBody = inspectResponse.body.length === 0 ? {} : (JSON.parse(inspectResponse.body) as unknown);
    } catch (cause) {
      return yield* Effect.fail(
        new ProviderInternalError({
          providerId: PROVIDER_ID,
          operation: "pullArtifact",
          message: "Docker API returned malformed JSON.",
          details: inspectResponse,
          cause,
          remediation: PULL_REMEDIATION,
        }),
      );
    }

    const digest = digestFromInspectBody(inspectBody);
    return { ref: reference, ...(digest === undefined ? {} : { digest }) };
  });
