import { Effect, Layer } from "effect";
import * as HttpClient from "effect/http/HttpClient";

import { ProviderUnavailableError, ScannerError } from "@lando/sdk/errors";
import { type AppId, type AppPlan, type ProviderId, ServiceName } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import {
  type PortCollision,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
  UrlScanner,
  type UrlScannerShape,
} from "@lando/sdk/services";

import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";
import { collectObservedConnections, observeService } from "../../operations/connection-collector.ts";
import { observedPublicationConnection, serviceState } from "../../operations/service-connections.ts";
import {
  SCANNER_ID,
  type ScanSourceEndpoint,
  type UrlScanConfig,
  type UrlScannerDeps,
  defaultUrlScanConfig,
  publishedHostPort,
  scanConfigFromPlan,
  scanTarget,
  scanTargets,
} from "./scan-target.ts";

export {
  SCANNER_ID,
  defaultUrlScanConfig,
  type ScanSourceEndpoint,
  type UrlScanConfig,
  type UrlScannerDeps,
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
  return UrlScanner.of({
    id: SCANNER_ID,
    scan: Effect.fn("UrlScanner.scan")(function* (appId, options) {
      if (options?.plan === undefined && options?.urls === undefined && !config.enabled) {
        return { appId, endpoints: [] };
      }
      const redactor = yield* resolveRedactor;
      const candidates =
        options?.urls === undefined
          ? (yield* deps.listEndpoints(appId, options?.plan)).flatMap((endpoint) => {
              const scan = options?.plan?.services[endpoint.service]?.scanner;
              const resolved = scan === undefined ? config : scanConfigFromPlan(scan, config);
              return resolved.enabled
                ? scanTargets([endpoint], resolved.path).map((target) => ({ target, config: resolved }))
                : [];
            })
          : options.urls.flatMap((supplied) => {
              const protocol = URL.parse(supplied.url)?.protocol;
              const host = URL.parse(supplied.url)?.hostname;
              if (
                (protocol !== undefined && protocol !== "http:" && protocol !== "https:") ||
                host?.includes("*")
              )
                return [];
              const scan = options.plan?.services[supplied.service]?.scanner;
              const resolved = scan === undefined ? config : scanConfigFromPlan(scan, config);
              return resolved.enabled ? [{ target: supplied, config: resolved }] : [];
            });
      const targets = [
        ...new Map(
          candidates.map((entry) => [`${entry.target.service}/${entry.target.url}`, entry]),
        ).values(),
      ];
      const scanned = yield* Effect.forEach(
        targets,
        ({ target, config }) =>
          scanTarget(
            { ...deps, ...(options?.onAttempt === undefined ? {} : { onAttempt: options.onAttempt }) },
            config,
            redactor,
            target,
          ),
        { concurrency: 4 },
      );
      return { appId, endpoints: scanned };
    }),
    detectCollisions: Effect.fn("UrlScanner.detectCollisions")(function* (appIds) {
      const claims = new Map<number, Array<{ appId: AppId; service: ServiceName }>>();
      for (const app of appIds) {
        const endpoints = yield* deps.listEndpoints(app);
        for (const endpoint of endpoints) {
          const hostPort = publishedHostPort(endpoint);
          if (hostPort === undefined) continue;
          const claimants = claims.get(hostPort) ?? [];
          claimants.push({ appId: app, service: endpoint.service });
          claims.set(hostPort, claimants);
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
  ): Effect.fn.Return<ReadonlyArray<ScanSourceEndpoint>, ScannerError> {
    const redactor = yield* resolveRedactor;
    const plans =
      provider.appliedPlans === undefined
        ? []
        : yield* provider.appliedPlans.pipe(Effect.mapError((error) => providerListError(error, redactor)));
    const plan = suppliedPlan ?? plans.find((plan) => plan.id === appId);
    const infos = yield* (
      plan === undefined
        ? provider.list({ app: appId })
        : Effect.forEach(Object.values(plan.services), (service) =>
            provider.inspect({ app: appId, service: service.name, plan }),
          )
    ).pipe(Effect.mapError((error) => providerListError(error, redactor)));
    if (plan !== undefined) {
      const rows = yield* collectObservedConnections(
        plan,
        infos.map((runtime) => observeService(plan, runtime)),
      );
      return rows.flatMap((row) =>
        row.connections.map((connection) => ({ ...connection, service: ServiceName.make(row.name) })),
      );
    }
    return infos.flatMap((runtime) =>
      runtime.publications.status === "present"
        ? runtime.publications.bindings.map((binding) => ({
            ...observedPublicationConnection(binding, serviceState(runtime.state ?? runtime.status)),
            service: runtime.service,
          }))
        : [],
    );
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
            const inspectAppliedPlans = (id: ProviderId) =>
              registry
                .select(id)
                .pipe(Effect.flatMap((candidate) => candidate.appliedPlans ?? Effect.succeed([])));
            // The first provider that could not be inspected keeps its own tag and remediation.
            let uninspected: Effect.Error<ReturnType<typeof inspectAppliedPlans>> | undefined;
            for (const id of yield* registry.list) {
              const inspected = yield* Effect.result(inspectAppliedPlans(id));
              if (inspected._tag === "Failure") {
                uninspected ??= inspected.failure;
                continue;
              }
              const plan = inspected.success.find((plan) => plan.id === appId);
              if (plan !== undefined) return yield* registry.select(plan);
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
          const provider = yield* selected.pipe(
            Effect.mapError((error) => providerListError(error, redactor)),
          );
          return yield* listEndpointsFromProvider(provider)(appId, suppliedPlan);
        }),
      });
    }),
  );
