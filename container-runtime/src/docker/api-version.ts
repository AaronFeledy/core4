import { ProviderUnavailableError } from "@lando/sdk/errors";

import type { ProviderErrorContext } from "../engine-api.ts";

/** Lowest Docker Engine API version Lando prefers. Today's sockets stay here unless the daemon requires more. */
export const DOCKER_API_PREFERRED_VERSION = "1.43";

/** Highest Docker Engine API version this client has been tested against. */
export const DOCKER_API_MAX_TESTED_VERSION = "1.44";

/** Preferred API path prefix. Call sites must resolve a negotiated prefix instead of treating this as a pin. */
export const DOCKER_API_PREFIX = `/v${DOCKER_API_PREFERRED_VERSION}` as const;

export const DOCKER_API_VERSION_ERROR_KIND = "docker-api-version" as const;

export interface DockerApiVersionComponents {
  readonly major: number;
  readonly minor: number;
}

export interface DockerDaemonApiRange {
  readonly apiVersion?: string;
  readonly minApiVersion?: string;
}

export interface DockerApiNegotiationOk {
  readonly ok: true;
  readonly version: string;
  readonly prefix: string;
}

export interface DockerApiNegotiationFail {
  readonly ok: false;
  readonly message: string;
  readonly ourRange: string;
  readonly daemonRange: string;
  readonly details: DockerApiVersionErrorDetails;
}

export type DockerApiNegotiation = DockerApiNegotiationOk | DockerApiNegotiationFail;

export interface DockerApiVersionErrorDetails {
  readonly kind: typeof DOCKER_API_VERSION_ERROR_KIND;
  readonly ourMin: string;
  readonly ourMax: string;
  readonly daemonMin?: string;
  readonly daemonMax?: string;
  readonly ourRange: string;
  readonly daemonRange: string;
}

const VERSION_PATTERN = /^v?(\d+)\.(\d+)$/u;
const MIN_VERSION_MESSAGE_PATTERN = /minimum supported API version is\s+v?(\d+\.\d+)/iu;
const VERSION_REJECTION_PATTERN =
  /minimum supported API version is|client version\s+\S+\s+is too (?:old|new)/iu;

export const parseDockerApiVersion = (value: string): DockerApiVersionComponents | undefined => {
  const match = VERSION_PATTERN.exec(value.trim());
  if (match === null) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]) };
};

export const compareDockerApiVersion = (left: string, right: string): number | undefined => {
  const leftVersion = parseDockerApiVersion(left);
  const rightVersion = parseDockerApiVersion(right);
  if (leftVersion === undefined || rightVersion === undefined) return undefined;
  if (leftVersion.major !== rightVersion.major) return leftVersion.major - rightVersion.major;
  return leftVersion.minor - rightVersion.minor;
};

export const formatDockerApiVersion = (value: string): string | undefined => {
  const parsed = parseDockerApiVersion(value);
  if (parsed === undefined) return undefined;
  return `${parsed.major}.${parsed.minor}`;
};

export const dockerApiPrefixFor = (version: string): string => `/v${version}`;

export const dockerApiVersionFromPrefix = (prefix: string): string | undefined => {
  const trimmed = prefix.replace(/\/+$/u, "");
  if (!trimmed.startsWith("/v")) return undefined;
  return formatDockerApiVersion(trimmed.slice(2));
};

export const maxDockerApiVersion = (left: string, right: string): string => {
  const comparison = compareDockerApiVersion(left, right);
  return comparison !== undefined && comparison >= 0 ? left : right;
};

export const formatDockerApiRange = (min?: string, max?: string): string => {
  if (min !== undefined && max !== undefined) return min === max ? min : `${min}-${max}`;
  if (min !== undefined) return `${min}+`;
  if (max !== undefined) return `up to ${max}`;
  return "unspecified";
};

export const landoDockerApiRangeLabel = (): string =>
  formatDockerApiRange(DOCKER_API_PREFERRED_VERSION, DOCKER_API_MAX_TESTED_VERSION);

export const daemonDockerApiRangeLabel = (range: DockerDaemonApiRange): string =>
  formatDockerApiRange(range.minApiVersion, range.apiVersion);

const negotiationFailure = (message: string, range: DockerDaemonApiRange): DockerApiNegotiationFail => {
  const ourRange = landoDockerApiRangeLabel();
  const daemonRange = daemonDockerApiRangeLabel(range);
  return {
    ok: false,
    message,
    ourRange,
    daemonRange,
    details: {
      kind: DOCKER_API_VERSION_ERROR_KIND,
      ourMin: DOCKER_API_PREFERRED_VERSION,
      ourMax: DOCKER_API_MAX_TESTED_VERSION,
      ...(range.minApiVersion === undefined ? {} : { daemonMin: range.minApiVersion }),
      ...(range.apiVersion === undefined ? {} : { daemonMax: range.apiVersion }),
      ourRange,
      daemonRange,
    },
  };
};

export const negotiateDockerApiVersion = (range: DockerDaemonApiRange = {}): DockerApiNegotiation => {
  const minApiVersion =
    range.minApiVersion === undefined ? undefined : formatDockerApiVersion(range.minApiVersion);
  const apiVersion = range.apiVersion === undefined ? undefined : formatDockerApiVersion(range.apiVersion);
  if (range.minApiVersion !== undefined && minApiVersion === undefined) {
    return negotiationFailure(
      `Docker Engine reported an unreadable MinAPIVersion "${range.minApiVersion}".`,
      range,
    );
  }
  if (range.apiVersion !== undefined && apiVersion === undefined) {
    return negotiationFailure(
      `Docker Engine reported an unreadable ApiVersion "${range.apiVersion}".`,
      range,
    );
  }

  const normalized: DockerDaemonApiRange = {
    ...(apiVersion === undefined ? {} : { apiVersion }),
    ...(minApiVersion === undefined ? {} : { minApiVersion }),
  };
  const version =
    minApiVersion === undefined
      ? DOCKER_API_PREFERRED_VERSION
      : maxDockerApiVersion(DOCKER_API_PREFERRED_VERSION, minApiVersion);

  if (apiVersion !== undefined) {
    const vsDaemonMax = compareDockerApiVersion(version, apiVersion);
    if (vsDaemonMax !== undefined && vsDaemonMax > 0) {
      return negotiationFailure(
        `Cannot negotiate a Docker Engine API version. Lando supports ${landoDockerApiRangeLabel()}; this daemon reports ${daemonDockerApiRangeLabel(normalized)}.`,
        normalized,
      );
    }
  }

  const vsMaxTested = compareDockerApiVersion(version, DOCKER_API_MAX_TESTED_VERSION);
  if (vsMaxTested !== undefined && vsMaxTested > 0) {
    return negotiationFailure(
      `Cannot negotiate a Docker Engine API version. Lando supports ${landoDockerApiRangeLabel()}; this daemon reports ${daemonDockerApiRangeLabel(normalized)}.`,
      normalized,
    );
  }

  return { ok: true, version, prefix: dockerApiPrefixFor(version) };
};

export const parseDockerApiVersionOverride = (value: string): DockerApiNegotiation => {
  const version = formatDockerApiVersion(value);
  if (version === undefined) {
    return negotiationFailure(`DOCKER_API_VERSION "${value}" is not a Docker Engine API version.`, {});
  }
  const vsMaxTested = compareDockerApiVersion(version, DOCKER_API_MAX_TESTED_VERSION);
  if (vsMaxTested !== undefined && vsMaxTested > 0) {
    return negotiationFailure(
      `DOCKER_API_VERSION ${version} is above Lando's tested Docker Engine API range ${landoDockerApiRangeLabel()}.`,
      { apiVersion: version },
    );
  }
  return { ok: true, version, prefix: dockerApiPrefixFor(version) };
};

const headerValue = (headers: Readonly<Record<string, string>>, name: string): string | undefined => {
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === expected && value.trim() !== "") return value.trim();
  }
  return undefined;
};

const stringField = (record: Readonly<Record<string, unknown>>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
};

export const minApiVersionFromMessage = (message: string): string | undefined => {
  const match = MIN_VERSION_MESSAGE_PATTERN.exec(message);
  return match?.[1] === undefined ? undefined : formatDockerApiVersion(match[1]);
};

export const isDockerApiVersionRejection = (status: number, body: string): boolean =>
  status === 400 && VERSION_REJECTION_PATTERN.test(body);

export const extractDockerDaemonApiRange = (input: {
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}): DockerDaemonApiRange => {
  const headers = input.headers ?? {};
  let apiVersion = headerValue(headers, "api-version");
  let minApiVersion = headerValue(headers, "min-api-version");

  const body = input.body?.trim() ?? "";
  if (body.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(body);
      if (typeof parsed === "object" && parsed !== null) {
        const record = parsed as Record<string, unknown>;
        apiVersion ??=
          stringField(record, "ApiVersion") ??
          stringField(record, "APIVersion") ??
          stringField(record, "apiVersion");
        minApiVersion ??=
          stringField(record, "MinAPIVersion") ??
          stringField(record, "MinApiVersion") ??
          stringField(record, "minAPIVersion");
        const message = stringField(record, "message");
        if (minApiVersion === undefined && message !== undefined) {
          minApiVersion = minApiVersionFromMessage(message);
        }
      }
    } catch {
      // Body is not version JSON; fall through to plain-text parsing.
    }
  }
  if (minApiVersion === undefined && body !== "") {
    minApiVersion = minApiVersionFromMessage(body);
  }

  return {
    ...(apiVersion === undefined ? {} : { apiVersion: formatDockerApiVersion(apiVersion) ?? apiVersion }),
    ...(minApiVersion === undefined
      ? {}
      : { minApiVersion: formatDockerApiVersion(minApiVersion) ?? minApiVersion }),
  };
};

export const dockerApiRangeHasEvidence = (range: DockerDaemonApiRange): boolean =>
  range.apiVersion !== undefined || range.minApiVersion !== undefined;

export const isDockerApiVersionError = (error: unknown): error is ProviderUnavailableError => {
  if (!(error instanceof ProviderUnavailableError)) return false;
  if (typeof error.details !== "object" || error.details === null) return false;
  return Reflect.get(error.details, "kind") === DOCKER_API_VERSION_ERROR_KIND;
};

export const dockerApiVersionUnavailable = (
  ctx: ProviderErrorContext,
  negotiation: DockerApiNegotiationFail,
  operation = "docker-api",
): ProviderUnavailableError =>
  new ProviderUnavailableError({
    providerId: ctx.providerId,
    operation,
    message: negotiation.message,
    details: negotiation.details,
    remediation: `Use a Docker Engine whose API range overlaps ${negotiation.ourRange}, or set DOCKER_API_VERSION to a version in that range. Then rerun \`lando setup --provider=docker\` or \`lando doctor --provider=docker\`.`,
  });
