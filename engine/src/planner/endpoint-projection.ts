import type { NormalizedRoute } from "@lando/landofile/route-normalize";
import { LandofileValidationError } from "@lando/sdk/errors";
import { type LandofileShape, type PluginManifest, type ProviderId, ServiceName } from "@lando/sdk/schema";
import type { PluginRegistry, ServiceTypeHostFacts } from "@lando/sdk/services";
import { type Context, Effect, Result } from "effect";
import { endpointValidationError, normalizeEndpoints } from "../services/endpoint-normalizer.ts";
import {
  declarePreparedServiceEndpoints,
  prepareServiceComposition,
} from "../services/feature-preparation.ts";
import { declareAppEndpoints } from "./app-endpoint-projection.ts";
import { planServicePrimary } from "./effective-events.ts";
import { type ServiceEndpointProjection, unavailable } from "./endpoint-availability.ts";
import { bindRoute } from "./endpoint-routes.ts";
import { type PlannerIssue, attributePlannerIssue } from "./resolved-validation.ts";
import { plannerSeededFeatureIds } from "./seed-validation.ts";
import { declaredServiceFeatures, loadServiceFeatures } from "./service-feature-input.ts";
import type { ResolvedServiceSeed } from "./service-seeds.ts";
import { servicePlanError } from "./service-types.ts";

export const projectEndpoints = Effect.fnUntraced(function* (input: {
  readonly services: readonly ResolvedServiceSeed[];
  readonly unavailable: ReadonlyMap<string, readonly PlannerIssue[]>;
  readonly landofile: LandofileShape;
  readonly manifests: readonly PluginManifest[];
  readonly pluginRegistry: Context.Service.Shape<typeof PluginRegistry>;
  readonly appName: string;
  readonly appSlug: string;
  readonly appRoot: string;
  readonly provider: ProviderId;
  readonly host: ServiceTypeHostFacts | undefined;
  readonly env: Readonly<Record<string, string>>;
  readonly gpgForward: boolean;
  readonly routes: ReadonlyMap<string, readonly NormalizedRoute[] | undefined>;
}) {
  const rows = new Map<string, ServiceEndpointProjection>();
  const issues: PlannerIssue[] = [];
  const record = (error: LandofileValidationError) => {
    const reasons = error.issues.map((issue) =>
      attributePlannerIssue(input.landofile, { ...issue, rule: "landofile.service" }),
    );
    issues.push(...reasons);
    return reasons;
  };
  for (const [name, reasons] of input.unavailable) {
    const failure = unavailable(reasons);
    rows.set(name, { preparation: failure, contributions: failure, endpoints: failure });
  }
  for (const seed of input.services) {
    const { resolution, name, serviceType } = seed;
    const loaded = yield* loadServiceFeatures(
      input.pluginRegistry,
      declaredServiceFeatures(resolution, input.gpgForward),
    ).pipe(
      Effect.mapError((error) => servicePlanError(input.appRoot, name, error)),
      Effect.result,
    );
    if (Result.isFailure(loaded)) {
      const failure = unavailable(record(loaded.failure));
      rows.set(name, { preparation: failure, contributions: failure, endpoints: failure });
      continue;
    }
    const prepared = prepareServiceComposition({
      ...loaded.success,
      base: {
        name: ServiceName.make(name),
        type: resolution.normalizedConfig.type ?? serviceType.id,
        serviceTypeId: serviceType.id,
        provider: input.provider,
        primary: planServicePrimary(name, resolution.normalizedConfig.primary),
        defaultFeatures: loaded.success.defaultFeatures,
        ...(resolution.connection === undefined ? {} : { connection: resolution.connection }),
        ...(resolution.nonSqlCreds === undefined ? {} : { nonSqlCreds: resolution.nonSqlCreds }),
        ...(resolution.normalizedConfig.environment === undefined
          ? {}
          : { environment: resolution.normalizedConfig.environment }),
      },
      baseKind: resolution.base,
      appName: input.appName,
      appSlug: input.appSlug,
      appRoot: input.appRoot,
      host: input.host,
      normalizedConfig: resolution.normalizedConfig,
      resolutionMetadata: resolution.metadata,
    });
    const declared = yield* declarePreparedServiceEndpoints(prepared);
    if (declared.errors.length > 0) {
      const failure = unavailable(
        declared.errors.flatMap((error) => record(servicePlanError(input.appRoot, name, error))),
      );
      rows.set(name, {
        preparation: { _tag: "Available", value: declared.prepared },
        contributions: failure,
        endpoints: failure,
      });
    } else {
      const substituted = plannerSeededFeatureIds(resolution.base);
      const claims = new Set(
        declared.prepared.features
          .filter((feature) => !substituted.has(feature.id))
          .flatMap((feature) => feature.validation?.handledServiceFields ?? []),
      );
      for (const field of ["webroot", "consolePort", "uploadDirs"] as const) {
        if (seed.authoredService[field] === undefined || claims.has(field)) continue;
        if (field === "uploadDirs" && seed.authoredService.uploadDirs?.length === 0) continue;
        const { message, remediation } = {
          webroot: {
            message: `Service ${name} sets webroot, but nothing in this service uses it.`,
            remediation:
              "Remove webroot from this service, or set it on the service that serves your app's files.",
          },
          consolePort: {
            message: `Service ${name} sets consolePort, but nothing in this service uses it.`,
            remediation:
              "Remove consolePort. Only services with a separate console listener, such as MinIO, use it.",
          },
          uploadDirs: {
            message: `Service ${name} lists uploadDirs, but Lando can't keep PHP out of them on this service.`,
            remediation:
              "Set uploadDirs on the service that serves PHP: an nginx service with a PHP-FPM backend, or a php service using via: apache, with Lando's generated server configuration. Otherwise remove it or set uploadDirs: [], and block PHP in those directories in your own server configuration.",
          },
        }[field];
        record(
          new LandofileValidationError({
            file: `${input.appRoot}/.lando.yml`,
            message,
            remediation,
            issues: [{ path: ["services", name, field], message, suggestion: remediation }],
          }),
        );
      }
      rows.set(name, {
        preparation: { _tag: "Available", value: declared.prepared },
        contributions: { _tag: "Available", value: declared.contributions },
        endpoints: { _tag: "Available", value: [] },
      });
    }
  }
  const app = yield* declareAppEndpoints({ ...input, rows });
  issues.push(...app.issues);
  for (const [name, row] of rows) {
    const config = input.landofile.services?.[ServiceName.make(name)];
    if (config === undefined) continue;
    const normalizedConfig =
      row.preparation._tag === "Available" ? row.preparation.value.facts.normalizedConfig : config;
    if (normalizedConfig.endpoints === undefined && row.contributions._tag === "Unavailable") {
      rows.set(name, { ...row, endpoints: row.contributions });
      continue;
    }
    const normalized = normalizeEndpoints(
      row.contributions._tag === "Available" ? row.contributions.value : [],
      normalizedConfig,
    );
    const error = endpointValidationError(normalized, { appRoot: input.appRoot, serviceName: name });
    rows.set(name, {
      ...row,
      endpoints: error === undefined ? { _tag: "Available", value: normalized } : unavailable(record(error)),
    });
  }
  for (const [name, routes] of input.routes) {
    const row = rows.get(name);
    if (row === undefined || row.endpoints._tag === "Unavailable") continue;
    for (const route of routes ?? []) {
      const binding = bindRoute(name, row.endpoints.value, route);
      if (Result.isFailure(binding)) issues.push({ ...binding.failure, rule: "landofile.route" });
    }
  }
  return { services: rows, preparedApp: app.prepared, issues };
});
