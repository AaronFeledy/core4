import {
  type CapabilityError,
  LandofileValidationError,
  type PublicationUnsupportedError,
} from "@lando/sdk/errors";
import {
  ServiceName,
  type ServicePlan,
  type ValidationIssuePath,
  landoNetworkingPlan,
} from "@lando/sdk/schema";
import { Effect, Predicate, Result } from "effect";
import { routerEnabledFrom } from "../config/router-config.ts";
import { isComposeBuild } from "../services/compose-build-artifact.ts";
import { mergeComposeKnobs } from "../services/compose-knobs.ts";
import { runtimeFollowLogSources } from "../services/redirect-log-sources.ts";
import { resolveGpgAgentIntent } from "../subsystems/gpg-agent/intent.ts";
import { SSH_AGENT_FEATURE_ID } from "../subsystems/ssh/api.ts";
import { resolveSshAgentIntent } from "../subsystems/ssh/intent.ts";
import { compileAuthoredMounts } from "./authored-mounts.ts";
import {
  appFeatureCapabilityError,
  assertAuthoredNetworksSupported,
  assertComposeKnobsSupported,
  assertComposePreservedPathsSupported,
  assertComposeProjectFieldsSupported,
  assertComposeServiceFieldsSupported,
  providerSatisfiesCapability,
} from "./compose-capabilities.ts";
import type { ResolvedLandofile } from "./event-set.ts";
import { mergeComposeExtension } from "./extensions.ts";
import { normalizeNetworks } from "./networks.ts";
import type { PlannerIssue } from "./resolved-validation.ts";
import {
  agentSocketCapabilityErrors,
  assertRouteNetworkingSupported,
  publicationCapabilityError,
  requiredLogSourceCapabilityError,
  serviceResourceCapabilityErrors,
} from "./resource-capabilities.ts";

type CapabilityIssue = PlannerIssue & { readonly severity?: "error" | "warning" };

const capabilityPath = (
  error: CapabilityError | PublicationUnsupportedError,
  resolution: ResolvedLandofile,
): ValidationIssuePath => {
  const prefix = error.service === undefined ? [] : ["services", error.service];
  if (error._tag === "PublicationUnsupportedError") return [...prefix, "endpoints"];
  if (error.key !== undefined) {
    if (error.capability === "authoredNetworks") {
      const service = resolution.services.find(
        (seed) => seed.service.networks?.default?.aliases !== undefined,
      );
      return service === undefined
        ? ["networks"]
        : ["services", service.name, "networks", "default", "aliases"];
    }
    if (error.key === "depends_on.*.restart") {
      const service = resolution.services.find((seed) => seed.name === error.service);
      const dependency = service?.service.dependsOn?.find((entry) => entry.restart !== undefined);
      return dependency === undefined
        ? [...prefix, "depends_on"]
        : [...prefix, "depends_on", dependency.service, "restart"];
    }
    return [...prefix, ...error.key.split(".")];
  }
  const field = {
    artifactBuild: "build",
    bindMounts: "appMount",
    persistentStorage: "storage",
    sharedCrossAppNetwork: "routes",
  }[error.capability];
  return field === undefined ? prefix : [...prefix, field];
};

export const lintCapabilityIssues = Effect.fn("AppPlanner.lintCapabilities")(function* (
  resolution: ResolvedLandofile,
): Effect.fn.Return<readonly CapabilityIssue[]> {
  const { capabilities, provider, landofile } = resolution;
  if (capabilities === undefined)
    return [
      {
        rule: "landofile.capability",
        severity: "warning",
        path: ["provider"],
        message: `Provider ${provider} has no offline capability declaration; capability checks run at lando start.`,
        suggestion:
          "Install or select a provider with an offline capability declaration, or run lando start to check runtime capabilities.",
      },
    ];
  const issues: CapabilityIssue[] = [];
  const ssh = resolveSshAgentIntent({ landofile, globalConfig: resolution.globalConfig });
  const gpg = resolveGpgAgentIntent({ landofile, globalConfig: resolution.globalConfig });
  const record = (
    error: CapabilityError | PublicationUnsupportedError,
    path = capabilityPath(error, resolution),
  ) =>
    issues.push({
      rule: "landofile.capability",
      severity: "error",
      path,
      message: error.message,
      ...(error.remediation === undefined ? {} : { suggestion: error.remediation }),
    });
  const check = Effect.fnUntraced(function* (assertion: Effect.Effect<void, CapabilityError>) {
    const result = yield* assertion.pipe(Effect.result);
    if (Result.isFailure(result)) record(result.failure);
  });
  for (const seed of resolution.services) {
    const name = ServiceName.make(seed.name);
    const base: Pick<ServicePlan, "name" | "extensions"> = { name, extensions: {} };
    const view = mergeComposeKnobs(mergeComposeExtension(base, seed.service), seed.service);
    const compose = view.extensions.compose;
    if (Predicate.isObject(compose))
      for (const [key, value] of Object.entries(compose)) {
        const services = { [name]: { name, extensions: { compose: { [key]: value } } } };
        yield* check(assertComposeKnobsSupported(provider, capabilities, services));
        yield* check(assertComposeServiceFieldsSupported(provider, capabilities, services));
        yield* check(assertComposePreservedPathsSupported(provider, capabilities, services));
      }
    const config = seed.resolution.normalizedConfig;
    const compiledMounts = compileAuthoredMounts(
      {
        appRoot: resolution.appRoot,
        appSlug: resolution.appSlug,
        serviceName: name,
        configs: landofile.configs,
      },
      config,
      seed.service.storage,
    );
    const mounts = compiledMounts instanceof LandofileValidationError ? [] : compiledMounts;
    const projection = resolution.endpointProjection.services.get(seed.name);
    const endpoints = projection?.endpoints;
    const publicationError = publicationCapabilityError(provider, capabilities, {
      name,
      published:
        endpoints?._tag === "Available" && endpoints.value.some((endpoint) => endpoint._tag === "published"),
    });
    if (publicationError !== undefined)
      record(publicationError, ["services", name, config.ports === undefined ? "endpoints" : "ports"]);
    for (const source of runtimeFollowLogSources(seed.logSources).filter(
      (source) => source.required === true,
    )) {
      const error = requiredLogSourceCapabilityError(provider, capabilities, { name, id: String(source.id) });
      if (error !== undefined) record(error, ["services", name, "logs"]);
    }
    const preparation = projection?.preparation;
    for (const error of agentSocketCapabilityErrors(provider, capabilities, {
      name,
      hostSsh:
        ssh.mode === "host" &&
        preparation?._tag === "Available" &&
        preparation.value.features.some((feature) => feature.id === SSH_AGENT_FEATURE_ID),
      gpgForward: gpg.forward && seed.resolution.base === "lando",
    }))
      record(error, error.feature === "lando.gpg-agent" ? ["gpgAgent", "forward"] : ["sshAgent"]);
    for (const error of serviceResourceCapabilityErrors(provider, capabilities, {
      name,
      bindMounts:
        (seed.resolution.base === "lando" && config.appMount !== false) ||
        mounts.some((mount) => mount.type === "bind"),
      artifactBuild: config.build !== undefined && isComposeBuild(config.build),
      persistentStorage: mounts.some((mount) => mount.type === "volume"),
    }))
      record(error);
  }
  for (const key of ["configs", "secrets"] as const) {
    if (landofile[key] !== undefined)
      yield* check(
        assertComposeProjectFieldsSupported(provider, capabilities, { compose: { [key]: landofile[key] } }),
      );
  }
  const normalized = yield* normalizeNetworks({
    landofile,
    services: Object.fromEntries(resolution.services.map((seed) => [seed.name, seed.service])),
    appRoot: resolution.appRoot,
    perAppBridge: resolution.appSlug !== "global",
  }).pipe(Effect.result);
  if (Result.isSuccess(normalized))
    yield* check(
      assertAuthoredNetworksSupported(
        provider,
        capabilities,
        landoNetworkingPlan({
          slug: resolution.appSlug,
          serviceNames: resolution.services.map((seed) => seed.name),
          perAppBridge: resolution.appSlug !== "global",
          sharedCrossAppNetwork: capabilities.sharedCrossAppNetwork,
          ...normalized.success,
        }),
      ),
    );
  else for (const issue of normalized.failure.issues) issues.push({ ...issue, rule: "landofile.network" });
  yield* check(
    assertRouteNetworkingSupported(
      provider,
      capabilities,
      routerEnabledFrom(resolution.globalConfig?.router, landofile.router) &&
        [...resolution.routes.values()].some((routes) => (routes?.length ?? 0) > 0),
    ),
  );
  for (const { feature } of resolution.endpointProjection.preparedApp.activations) {
    for (const capability of feature.definition.requires?.providerCapabilities ?? []) {
      if (!providerSatisfiesCapability(capabilities, capability))
        record(appFeatureCapabilityError(provider, feature.id, capability));
    }
  }
  return issues;
});
