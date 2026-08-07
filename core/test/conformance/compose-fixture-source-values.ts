import type { ServiceConfig } from "@lando/core/schema";

import type { ComposeDispositionMatch } from "@lando/landofile/compose/rejections";
import type { ComposePlanAssertion } from "./compose-fixture-assertion-metadata.ts";
import { ComposeFixtureOutcomeError, valueAt } from "./compose-fixture-outcome-values.ts";

type CanonicalVolume = NonNullable<ServiceConfig["volumes"]>[number];

export const serviceDocumentPath = (match: ComposeDispositionMatch): string => {
  if (match.service === undefined) throw new ComposeFixtureOutcomeError("Service match missing service name");
  const prefix = `services.${match.service}.`;
  if (!match.documentPath.startsWith(prefix)) throw new ComposeFixtureOutcomeError("Invalid service path");
  return match.documentPath.slice(prefix.length);
};

const matchedIndex = (match: ComposeDispositionMatch, root: string): number => {
  const index = serviceDocumentPath(match).match(new RegExp(`^${root}\\[(\\d+)\\]`, "u"))?.[1];
  if (index === undefined)
    throw new ComposeFixtureOutcomeError(`Missing decoded index for ${match.documentPath}`);
  return Number(index);
};

const requiredMapEntry = (
  value: Readonly<Record<string, unknown>> | undefined,
  key: string | undefined,
  match: ComposeDispositionMatch,
): unknown => {
  if (value === undefined || key === undefined || !Object.hasOwn(value, key)) {
    throw new ComposeFixtureOutcomeError(`Matched source ${match.documentPath} did not survive decode`);
  }
  return value[key];
};

export const requireDecodedSource = (value: unknown, match: ComposeDispositionMatch): unknown => {
  if (
    value === undefined ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0)
  ) {
    throw new ComposeFixtureOutcomeError(`Matched source ${match.documentPath} did not survive decode`);
  }
  return value;
};

export const requirePresentValue = (
  value: unknown,
  match: ComposeDispositionMatch,
  location: string,
): unknown => {
  if (value === undefined) {
    throw new ComposeFixtureOutcomeError(`Matched source ${match.documentPath} is missing at ${location}`);
  }
  return value;
};

export const requireProducedValue = (
  value: unknown,
  match: ComposeDispositionMatch,
  target: string,
): unknown => {
  if (
    value === undefined ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0)
  ) {
    throw new ComposeFixtureOutcomeError(`Matched source ${match.documentPath} produced no ${target}`);
  }
  return value;
};

export const matchedVolumes = (
  match: ComposeDispositionMatch,
  service: ServiceConfig,
): ReadonlyArray<CanonicalVolume> => {
  const volumes = service.volumes;
  if (match.matrixPath === "volumes") {
    requireDecodedSource(volumes, match);
    return volumes ?? [];
  }
  const volume = volumes?.[matchedIndex(match, "volumes")];
  requireDecodedSource(volume, match);
  return volume === undefined ? [] : [volume];
};

const normalizedVolumeSource = (match: ComposeDispositionMatch, service: ServiceConfig): unknown => {
  const volumes = matchedVolumes(match, service);
  if (match.matrixPath === "volumes") return volumes;
  const volume = volumes[0];
  if (volume === undefined) return undefined;
  switch (match.matrixPath) {
    case "volumes.bind":
      return volume.type === "bind" ? volume : undefined;
    case "volumes.bind.create_host_path":
      return volume.createHostPath;
    case "volumes.read_only":
      return volume.readOnly;
    case "volumes.source":
      return volume.source;
    case "volumes.target":
      return volume.target;
    case "volumes.type":
      return volume.type;
    case "volumes.volume":
      return volume.type === "volume" ? volume : undefined;
    case "volumes.volume.subpath":
      return volume.subpath;
    default:
      return volume;
  }
};

export const normalizedSourceValue = (request: {
  readonly match: ComposeDispositionMatch;
  readonly service: ServiceConfig;
  readonly assertion: ComposePlanAssertion;
  readonly configTarget: string;
}): unknown => {
  const { assertion, configTarget, match, service } = request;
  const relativePath = serviceDocumentPath(match);
  switch (assertion) {
    case "artifact-build": {
      const build = service.build;
      if (match.matrixPath === "build") return requireDecodedSource(build, match);
      if (match.matrixPath === "build.dockerfile_inline") return build?.dockerfileInline;
      if (match.matrixPath === "build.args.*") {
        return requiredMapEntry(build?.args, relativePath.slice("build.args.".length), match);
      }
      return valueAt(build, match.matrixPath.slice("build.".length));
    }
    case "artifact-ref":
      return service.image;
    case "dependencies": {
      if (match.matrixPath === "depends_on") return service.dependsOn;
      const dependencyName = relativePath.split(".")[1];
      const dependency = service.dependsOn?.find((candidate) => candidate.service === dependencyName);
      if (match.matrixPath === "depends_on.*") return dependency;
      return valueAt(dependency, match.matrixPath.slice("depends_on.*.".length));
    }
    case "environment":
      if (match.matrixPath === "env_file") return service.envFile;
      if (match.matrixPath === "environment") return service.environment;
      return requiredMapEntry(service.environment, relativePath.slice("environment.".length), match);
    case "healthcheck": {
      if (match.matrixPath === "healthcheck") return service.healthcheck;
      const field =
        {
          "healthcheck.disable": "kind",
          "healthcheck.interval": "intervalSeconds",
          "healthcheck.start_period": "startPeriodSeconds",
          "healthcheck.test": "kind",
          "healthcheck.timeout": "timeoutSeconds",
        }[match.matrixPath] ?? match.matrixPath.slice("healthcheck.".length);
      return valueAt(service.healthcheck, field);
    }
    case "internal-endpoints":
      return service.expose;
    case "published-endpoints": {
      if (match.matrixPath === "ports") return service.ports;
      const port = service.ports?.[matchedIndex(match, "ports")];
      const field =
        {
          "ports.app_protocol": "appProtocol",
          "ports.host_ip": "hostIp",
        }[match.matrixPath] ?? match.matrixPath.slice("ports.".length);
      return valueAt(port, field);
    }
    case "volumes":
      return normalizedVolumeSource(match, service);
    case "direct":
      return valueAt(service, configTarget);
    default: {
      const exhaustive: never = assertion;
      throw new ComposeFixtureOutcomeError(`Unhandled source assertion: ${exhaustive}`);
    }
  }
};

export const preservedSourceValue = (match: ComposeDispositionMatch, service: ServiceConfig): unknown => {
  if (match.matrixPath === "depends_on.*.restart") {
    const dependencyName = serviceDocumentPath(match).split(".")[1];
    return service.dependsOn?.find((candidate) => candidate.service === dependencyName)?.restart;
  }
  if (match.matrixPath === "healthcheck.start_interval") return service.healthcheck?.startInterval;
  if (match.matrixPath.startsWith("volumes.tmpfs")) {
    const volume = service.volumes?.[matchedIndex(match, "volumes")];
    if (match.matrixPath === "volumes.tmpfs") return volume?.tmpfs;
    return valueAt(volume?.tmpfs, match.matrixPath.slice("volumes.tmpfs.".length));
  }
  return valueAt(service, serviceDocumentPath(match));
};
