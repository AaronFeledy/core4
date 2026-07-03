import { Effect, Layer } from "effect";

import { ScannerError } from "@lando/sdk/errors";
import type { AppId, ServiceName } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import {
  type PortCollision,
  type ProviderError,
  RuntimeProvider,
  type RuntimeProviderShape,
  UrlScanner,
  type UrlScannerShape,
} from "@lando/sdk/services";

import { HttpClient } from "../../http-client/service.ts";
import { RedactionService, createStandaloneRedactor } from "../../redaction/service.ts";
import {
  SCANNER_ID,
  type ScanSourceEndpoint,
  type UrlScanConfig,
  type UrlScannerDeps,
  defaultUrlScanConfig,
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
  return {
    id: SCANNER_ID,
    scan: (appId) =>
      Effect.gen(function* () {
        if (!config.enabled) return { appId, endpoints: [] };
        const redactor = yield* resolveRedactor;
        const endpoints = yield* deps.listEndpoints(appId);
        const scanned = yield* Effect.forEach(
          scanTargets(endpoints, config.path),
          (target) => scanTarget(deps, config, redactor, target),
          { concurrency: "unbounded" },
        );
        return { appId, endpoints: scanned };
      }),
    detectCollisions: (appIds) =>
      Effect.gen(function* () {
        const claims = new Map<number, Array<{ appId: AppId; service: ServiceName }>>();
        for (const app of appIds) {
          const endpoints = yield* deps.listEndpoints(app);
          for (const endpoint of endpoints) {
            if (endpoint.port === undefined) continue;
            const claimants = claims.get(endpoint.port) ?? [];
            claimants.push({ appId: app, service: endpoint.service });
            claims.set(endpoint.port, claimants);
          }
        }
        const collisions: PortCollision[] = [];
        for (const [port, apps] of [...claims.entries()].sort((left, right) => left[0] - right[0])) {
          const distinctApps = new Set<AppId>(apps.map((claimant) => claimant.appId));
          if (distinctApps.size >= 2) collisions.push({ port, apps });
        }
        return collisions;
      }),
  };
};

const providerListError = (error: ProviderError, redactor: Redactor): ScannerError =>
  new ScannerError({
    message: redactor.redactString(
      `URL scan could not list provider services: ${error.message}. Check the provider with \`lando doctor\` and re-run the scan.`,
    ),
    scannerId: SCANNER_ID,
    cause: redactor.redactValue(error),
  });

const listEndpointsFromProvider =
  (provider: RuntimeProviderShape) =>
  (appId: AppId): Effect.Effect<ReadonlyArray<ScanSourceEndpoint>, ScannerError> =>
    Effect.gen(function* () {
      const redactor = yield* resolveRedactor;
      const infos = yield* provider
        .list({ app: appId })
        .pipe(Effect.mapError((error) => providerListError(error, redactor)));
      return infos.flatMap((info) =>
        (info.state ?? info.status) === "stopped" || info.endpoints === undefined
          ? []
          : info.endpoints.map((endpoint) => ({
              service: info.service,
              protocol: endpoint.protocol,
              ...(endpoint.port === undefined ? {} : { port: endpoint.port }),
            })),
      );
    });

export const UrlScannerLive: Layer.Layer<UrlScanner, never, RuntimeProvider | HttpClient> = Layer.effect(
  UrlScanner,
  Effect.gen(function* () {
    const provider = yield* RuntimeProvider;
    const http = yield* HttpClient;
    return makeUrlScanner({
      request: http.request,
      listEndpoints: listEndpointsFromProvider(provider),
    });
  }),
);

export const UrlScannerDefaultLayer = UrlScannerLive;
