import type { EngineHttpRequest } from "./engine-api.ts";

export interface WaitDialect {
  readonly request: (containerName: string, signal?: AbortSignal) => EngineHttpRequest;
  readonly decodeExitCode: (json: unknown) => number | undefined;
}

export interface PullDialect {
  readonly request: (reference: string) => EngineHttpRequest;
  readonly frameError: (frame: unknown) => string | undefined;
  readonly inspect?: {
    readonly request: (reference: string) => EngineHttpRequest;
    readonly decodeDigest: (json: unknown) => string | undefined;
  };
}

export interface LifecycleDialect {
  readonly wait: WaitDialect;
  /**
   * How service containers join the shared Lando network.
   *
   * `create-body` lists every network in the container create request. `connect-after-create`
   * lists only the app network there and attaches the shared network after creation for Docker
   * Engine API versions that honor only the first endpoint configuration.
   */
  readonly sharedNetworkAttachment: "create-body" | "connect-after-create";
  /**
   * Optional teardown-time prune of app-scoped volumes. Absence means the provider has no trusted
   * ownership-complete prune endpoint, so teardown removes only the plan's own volumes.
   */
  readonly volumePrune?: { readonly enabled: true };
}

export const parseImageReference = (
  reference: string,
): { readonly fromImage: string; readonly tag: string } => {
  const digestSeparator = reference.lastIndexOf("@");
  const taggedReference = digestSeparator === -1 ? reference : reference.slice(0, digestSeparator);
  const lastSlash = taggedReference.lastIndexOf("/");
  const tagSeparator = taggedReference.lastIndexOf(":");
  const hasTag = tagSeparator > lastSlash;
  const fromImage = hasTag ? taggedReference.slice(0, tagSeparator) : taggedReference;
  if (digestSeparator !== -1) return { fromImage, tag: reference.slice(digestSeparator + 1) };
  return { fromImage, tag: hasTag ? taggedReference.slice(tagSeparator + 1) : "latest" };
};

const objectString = (value: unknown, key: "error" | "message"): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate =
    key === "error"
      ? "error" in value
        ? value.error
        : undefined
      : "message" in value
        ? value.message
        : undefined;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
};

export const dockerWaitDialect: WaitDialect = {
  request: (containerName, signal) => ({
    method: "POST",
    path: `/containers/${encodeURIComponent(containerName)}/wait`,
    ...(signal === undefined ? {} : { signal }),
  }),
  decodeExitCode: (json) => {
    if (typeof json !== "object" || json === null || !("StatusCode" in json)) return undefined;
    return typeof json.StatusCode === "number" ? json.StatusCode : undefined;
  },
};

export const libpodWaitDialect: WaitDialect = {
  request: (containerName, signal) => ({
    method: "POST",
    path: `/libpod/containers/${encodeURIComponent(containerName)}/wait`,
    ...(signal === undefined ? {} : { signal }),
  }),
  decodeExitCode: (json) => (typeof json === "number" ? json : undefined),
};

export const libpodLifecycleDialect: LifecycleDialect = {
  wait: libpodWaitDialect,
  sharedNetworkAttachment: "create-body",
  volumePrune: { enabled: true },
};

export const dockerLifecycleDialect: LifecycleDialect = {
  wait: dockerWaitDialect,
  sharedNetworkAttachment: "connect-after-create",
};

export const dockerPullDialect: PullDialect = {
  request: (reference) => {
    const parsed = parseImageReference(reference);
    return {
      method: "POST",
      path: `/images/create?fromImage=${encodeURIComponent(parsed.fromImage)}&tag=${encodeURIComponent(parsed.tag)}`,
    };
  },
  frameError: (frame) => {
    if (typeof frame !== "object" || frame === null) return undefined;
    const detail = "errorDetail" in frame ? frame.errorDetail : undefined;
    if (typeof detail === "string" && detail.length > 0) return detail;
    return objectString(detail, "message") ?? objectString(frame, "error");
  },
  inspect: {
    request: (reference) => ({
      method: "GET",
      path: `/images/${encodeURIComponent(reference)}/json`,
    }),
    decodeDigest: (json) => {
      if (typeof json !== "object" || json === null || !("RepoDigests" in json)) return undefined;
      if (!Array.isArray(json.RepoDigests)) return undefined;
      const first = json.RepoDigests[0];
      if (typeof first !== "string") return undefined;
      const separator = first.indexOf("@");
      return separator === -1 ? undefined : first.slice(separator + 1);
    },
  },
};

export const libpodPullDialect: PullDialect = {
  request: (reference) => ({
    method: "POST",
    path: `/libpod/images/pull?reference=${encodeURIComponent(reference)}&pullProgress=true`,
  }),
  frameError: (frame) => objectString(frame, "error"),
};
