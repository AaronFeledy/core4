import { inventoryProtectsApp, protectedSlotError } from "@lando/container-runtime/applied-state";
import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";
import { mapFailures } from "@lando/sdk/command-result";
import { ProviderUnavailableError, ScannerError } from "@lando/sdk/errors";
import {
  type AppId,
  type AppPlan,
  type EndpointRef,
  ServiceName,
  type ServicePlan,
  isWildcardHostname,
} from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import {
  type PortCollision,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
  UrlScanner,
  type UrlScannerShape,
} from "@lando/sdk/services";
import { Effect, Layer, Result } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import { collectObservedConnections, observeService } from "../../operations/connection-collector.ts";
import {
  activeHostHttpAddresses,
  observedPublicationConnection,
  serviceStateOf,
} from "../../operations/service-connections.ts";
import { endpointScanPolicy } from "../../services/endpoint-scan.ts";
import { type ScanSourceService, appendScanPath, publishedHostPorts } from "./connection-targets.ts";
import {
  SCANNER_ID,
  type UrlScanConfig,
  type UrlScannerDeps,
  defaultUrlScanConfig,
  scanConfigFromPlan,
  scanTarget,
} from "./scan-target.ts";

export {
  SCANNER_ID,
  type UrlScanConfig,
  type UrlScannerDeps,
  defaultUrlScanConfig,
} from "./scan-target.ts";

const resolveRedactor = Effect.gen(function* () {
  const redaction = yield* Effect.serviceOption(RedactionService);
  if (redaction._tag === "None")
    return createStandaloneRedactor("secrets", { sourceEnv: { ...process.env } });
  return yield* redaction.value.forProfile("secrets", { sourceEnv: { ...process.env } });
});

export const makeUrlScanner = (
  deps: UrlScannerDeps,
  overrides: Partial<UrlScanConfig> = {},
): UrlScannerShape => {
  const config: UrlScanConfig = { ...defaultUrlScanConfig, ...overrides };
  const resolveConfig = (
    service: ServicePlan | undefined,
    endpoint: EndpointRef | undefined,
  ): UrlScanConfig => {
    const resolved = service?.scanner === undefined ? config : scanConfigFromPlan(service.scanner, config);
    const policy = endpointScanPolicy(service, endpoint);
    return { ...resolved, path: policy?.path ?? resolved.path, okCodes: policy?.okCodes ?? resolved.okCodes };
  };
  return UrlScanner.of({
    id: SCANNER_ID,
    scan: Effect.fn("UrlScanner.scan")(function* (appId, options) {
      if (options?.plan === undefined && options?.urls === undefined && !config.enabled) {
        return { appId, endpoints: [] };
      }
      const redactor = yield* resolveRedactor;
      const candidates =
        options?.urls === undefined
          ? (yield* deps.listEndpoints(appId, options?.plan)).flatMap((source) => {
              const service = options?.plan?.services[source.service] ?? source.servicePlan;
              return activeHostHttpAddresses(source).flatMap(({ endpoint, url }) => {
                const config = resolveConfig(service, endpoint);
                if (!config.enabled) return [];
                const target = { service: source.service, url: appendScanPath(url, config.path), endpoint };
                return [{ target, config, service }];
              });
            })
          : options.urls.flatMap((supplied) => {
              const parsed = URL.parse(supplied.url);
              if (
                parsed !== null &&
                ((parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
                  isWildcardHostname(parsed.hostname))
              )
                return [];
              const service = options.plan?.services[supplied.service];
              const resolved = resolveConfig(service, supplied.endpoint);
              return resolved.enabled ? [{ target: supplied, config: resolved, service }] : [];
            });
      const targets = [
        ...new Map(
          candidates.map((entry) => [`${entry.target.service}/${entry.target.url}`, entry]),
        ).values(),
      ];
      const scanDeps = {
        ...deps,
        ...(options?.onAttempt === undefined ? {} : { onAttempt: options.onAttempt }),
      };
      const scanned = yield* Effect.forEach(
        targets,
        ({ target, config, service }) => {
          const authority = service?.listenerAuthority;
          const idlePort =
            authority?.owner === "application" &&
            authority.keepAlive === true &&
            target.endpoint?.transport === "tcp" &&
            target.endpoint.port === authority.port
              ? authority.port
              : undefined;
          return scanTarget(scanDeps, config, redactor, {
            service: target.service,
            url: target.url,
            ...(idlePort === undefined ? {} : { idlePort }),
          });
        },
        { concurrency: 4 },
      );
      return { appId, endpoints: scanned };
    }),
    detectCollisions: Effect.fn("UrlScanner.detectCollisions")(function* (appIds) {
      const claims = new Map<number, Array<{ appId: AppId; service: ServiceName }>>();
      for (const app of appIds) {
        const endpoints = yield* deps.listEndpoints(app);
        for (const source of endpoints) {
          for (const hostPort of publishedHostPorts(source)) {
            const claimants = claims.get(hostPort) ?? [];
            claimants.push({ appId: app, service: source.service });
            claims.set(hostPort, claimants);
          }
        }
      }
      const collisions: PortCollision[] = [];
      for (const [port, apps] of [...claims.entries()].sort((left, right) => left[0] - right[0])) {
        const distinctApps = new Set<AppId>(apps.map((claimant) => claimant.appId));
        if (distinctApps.size >= 2) collisions.push({ port, apps });
      }
      return collisions;
    }),
  });
};

const providerListError = (
  error: { readonly message: string; readonly remediation?: string },
  redactor: Redactor,
): ScannerError =>
  new ScannerError({
    message: redactor.redactString(`App checks could not list provider services: ${error.message}`),
    scannerId: SCANNER_ID,
    cause: redactor.redactValue(error),
    // The provider's own remediation names the real fix; the fallback covers untagged failures.
    remediation: redactor.redactString(
      error.remediation ?? "Run lando doctor to inspect the provider, then re-run the URL checks.",
    ),
  });

const listEndpointsFromProvider = (provider: RuntimeProviderShape) =>
  Effect.fn("RuntimeProvider.listEndpoints")(function* (
    appId: AppId,
    suppliedPlan?: AppPlan,
  ): Effect.fn.Return<ReadonlyArray<ScanSourceService>, ScannerError> {
    const redactor = yield* resolveRedactor;
    const plans =
      provider.appliedPlans === undefined
        ? []
        : yield* provider.appliedPlans.pipe(mapFailures((error) => providerListError(error, redactor)));
    const plan = suppliedPlan ?? plans.find((plan) => plan.id === appId);
    const infos = yield* (
      plan === undefined
        ? provider.list({ app: appId })
        : Effect.forEach(Object.values(plan.services), (service) =>
            provider.inspect({ app: appId, service: service.name, plan }),
          )
    ).pipe(mapFailures((error) => providerListError(error, redactor)));
    if (plan !== undefined) {
      const rows = yield* collectObservedConnections(
        plan,
        infos.map((runtime) => observeService(plan, runtime)),
      );
      return rows.map(({ name, connections, routes }) => {
        const service = ServiceName.make(name);
        return { service, connections, routes, servicePlan: plan.services[service] };
      });
    }
    return infos.map((runtime) => ({
      service: runtime.service,
      connections:
        runtime.publications.status === "present"
          ? runtime.publications.bindings.map((binding) =>
              observedPublicationConnection(binding, serviceStateOf(runtime)),
            )
          : [],
      routes: [],
    }));
  });

export const layer: Layer.Layer<UrlScanner, never, RuntimeProviderRegistry | HttpClient.HttpClient> =
  Layer.effect(
    UrlScanner,
    Effect.gen(function* () {
      const registry = yield* RuntimeProviderRegistry;
      const http = yield* HttpClient.HttpClient;
      return makeUrlScanner({
        http,
        listEndpoints: Effect.fn("UrlScanner.listEndpoints")(function* (appId, suppliedPlan) {
          const redactor = yield* resolveRedactor;
          const selected = Effect.gen(function* () {
            if (suppliedPlan !== undefined) return yield* registry.select(suppliedPlan);
            const inspectAppliedPlans = registry.appliedStateInventory;
            // The first provider that could not be inspected keeps its own tag and remediation.
            let uninspected: Effect.Error<ReturnType<typeof inspectAppliedPlans>> | undefined;
            for (const id of yield* registry.list) {
              const inspected = yield* Effect.result(inspectAppliedPlans(id));
              if (Result.isFailure(inspected)) {
                uninspected ??= inspected.failure;
                continue;
              }
              const plan = inspected.success.plans.find((plan) => plan.id === appId && plan.provider === id);
              if (plan !== undefined) return yield* registry.select(plan);
              const issue = inspected.success.unreadable.find((entry) => inventoryProtectsApp(entry, appId));
              if (issue !== undefined) uninspected ??= protectedSlotError(id, issue, appId);
            }
            if (uninspected !== undefined) return yield* Effect.fail(uninspected);
            return yield* Effect.fail(
              new ProviderUnavailableError({
                providerId: "unknown",
                operation: "scan",
                message: `No applied provider plan was found for app ${appId}.`,
                remediation: `Start app ${appId} before scanning its endpoints.`,
              }),
            );
          });
          const provider = yield* selected.pipe(mapFailures((error) => providerListError(error, redactor)));
          return yield* listEndpointsFromProvider(provider)(appId, suppliedPlan);
        }),
      });
    }),
  );
