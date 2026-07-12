import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { LogFileHelperPayloads } from "@lando/container-runtime/log-file-helper-payloads";
import { type Context, Effect, Layer } from "effect";

import { makeRuntimeProvider as makeDockerRuntimeProvider } from "@lando/provider-docker";
import {
  type ArtifactDownload,
  type ArtifactDownloadResult,
  ProviderBundleChecksumError,
  makeRuntimeProvider as makeLandoRuntimeProvider,
} from "@lando/provider-lando";
import { makeRuntimeProvider as makePodmanRuntimeProvider } from "@lando/provider-podman";
import {
  DownloadChecksumError,
  NoProviderInstalledError,
  ProviderCapabilityError,
  ProviderConfigError,
  ProviderUnavailableError,
} from "@lando/sdk/errors";
import { ProviderId } from "@lando/sdk/schema";
import {
  ConfigService,
  Downloader,
  EventService,
  PathsService,
  PluginRegistry,
  RuntimeProvider,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
} from "@lando/sdk/services";

import { loadLogFileHelperPayloads } from "./log-file-helper-payloads.ts";
import {
  CAPABILITY_DEFAULT_PROVIDER_ID,
  readProviderEnvVar,
  resolveProviderSelection,
} from "./precedence.ts";

type EventPublisher = Pick<Context.Tag.Service<typeof EventService>, "publish">;

const contributionId = (entry: string | { readonly id: string }): string =>
  typeof entry === "string" ? entry : entry.id;

const providers: Readonly<Record<string, RuntimeProviderShape>> = {};

const toProviderUnavailable = (cause: unknown) =>
  new ProviderUnavailableError({
    providerId: "unknown",
    operation: "list",
    message: "Unable to list runtime provider plugins.",
    cause,
  });

const toProviderConfig = (cause: unknown) =>
  new ProviderConfigError({
    providerId: "unknown",
    operation: "select",
    message: "Unable to read the default runtime provider configuration.",
    cause,
  });

const toProviderUnavailableFromCapability = (
  cause: ProviderCapabilityError | ProviderUnavailableError,
): ProviderUnavailableError => {
  if (cause instanceof ProviderUnavailableError) return cause;
  if (cause instanceof ProviderCapabilityError) {
    return new ProviderUnavailableError({
      providerId: cause.providerId,
      operation: cause.operation,
      message: cause.message,
      ...(cause.details === undefined ? {} : { details: cause.details }),
      ...(cause.remediation === undefined ? {} : { remediation: cause.remediation }),
      cause,
    });
  }
  return new ProviderUnavailableError({
    providerId: "lando",
    operation: "capabilities",
    message: "Unable to initialize provider-lando capabilities.",
    cause,
  });
};

const toRuntimeBundleDownloadError = (cause: unknown): ProviderUnavailableError => {
  if (cause instanceof DownloadChecksumError) {
    return new ProviderBundleChecksumError("The Lando runtime bundle checksum did not match.", cause);
  }
  return new ProviderUnavailableError({
    providerId: "lando",
    operation: "setup",
    message: "Failed to download the provider-lando runtime bundle.",
    cause,
  });
};

export const makeArtifactDownload =
  (downloader: Context.Tag.Service<typeof Downloader>): ArtifactDownload =>
  (req) =>
    Effect.scoped(
      Effect.gen(function* () {
        const result = yield* downloader.download({
          url: req.url,
          destination: { kind: "file", directory: req.directory, filename: req.filename },
          expectedSha256: req.expectedSha256,
          ...(req.expectedSizeBytes === undefined ? {} : { expectedSizeBytes: req.expectedSizeBytes }),
          allowFileSource: req.allowFileSource,
        });
        const path = result.path ?? join(req.directory, req.filename);
        const bytes = yield* Effect.promise(() => readFile(path));
        return { bytes: new Uint8Array(bytes), sha256: result.sha256, path } satisfies ArtifactDownloadResult;
      }),
    ).pipe(Effect.mapError(toRuntimeBundleDownloadError));

const makeRuntimeProviderRegistry = (
  configService: Context.Tag.Service<typeof ConfigService>,
  pluginRegistry: Context.Tag.Service<typeof PluginRegistry>,
  eventService: EventPublisher | undefined,
  downloader: Context.Tag.Service<typeof Downloader>,
  landoPaths: Context.Tag.Service<typeof PathsService>,
  logFileHelperPayloads: LogFileHelperPayloads,
): Context.Tag.Service<typeof RuntimeProviderRegistry> => {
  const artifactDownload = makeArtifactDownload(downloader);

  const providerIds = Effect.mapError(
    Effect.map(pluginRegistry.list, (manifests) =>
      manifests
        .flatMap((manifest) => manifest.contributes?.providers ?? [])
        .map((entry) => ProviderId.make(contributionId(entry))),
    ),
    toProviderUnavailable,
  );

  const configuredProviderId = Effect.gen(function* () {
    const defaultProviderId = yield* Effect.mapError(
      configService.get("defaultProviderId"),
      toProviderConfig,
    );
    const envProviderId = readProviderEnvVar(process.env);
    return resolveProviderSelection({
      ...(envProviderId === undefined ? {} : { env: envProviderId }),
      ...(defaultProviderId === undefined || defaultProviderId === null ? {} : { config: defaultProviderId }),
      capabilityDefault: CAPABILITY_DEFAULT_PROVIDER_ID,
    }).providerId;
  });

  const providerFor = (providerId: ProviderId) =>
    Effect.gen(function* () {
      const installedProviderIds = yield* providerIds;
      const providerIdText = String(providerId);
      const installed = installedProviderIds.some((installedId) => String(installedId) === providerIdText);
      const userDataRoot = landoPaths.roots.userDataRoot;
      const provider =
        providerIdText === "lando"
          ? yield* makeLandoRuntimeProvider({
              stateDir: `${userDataRoot}/providers`,
              runtimeBinDir: landoPaths.runtimeBinDir,
              runtimeRunDir: landoPaths.runtimeRunDir,
              runtimeStorageDir: landoPaths.runtimeStorageDir,
              runtimeConfigDir: landoPaths.runtimeConfigDir,
              providerSocketPath: landoPaths.providerSocketPath,
              providerPidPath: landoPaths.providerPidPath,
              ...(eventService === undefined ? {} : { eventService }),
              artifactDownload,
              logFileHelperPayloads,
            }).pipe(Effect.mapError(toProviderUnavailableFromCapability))
          : providerIdText === "docker"
            ? yield* makeDockerRuntimeProvider({ logFileHelperPayloads }).pipe(
                Effect.mapError(toProviderUnavailableFromCapability),
              )
            : providerIdText === "podman"
              ? yield* makePodmanRuntimeProvider({
                  stateDir: `${userDataRoot}/providers`,
                  ...(eventService === undefined ? {} : { eventService }),
                  logFileHelperPayloads,
                }).pipe(Effect.mapError(toProviderUnavailableFromCapability))
              : providers[providerIdText];

      if (!installed || provider === undefined) {
        return yield* Effect.fail(
          new NoProviderInstalledError({
            message: `Runtime provider ${providerIdText} is not installed.`,
          }),
        );
      }

      return provider;
    });

  const activeProvider = Effect.flatMap(configuredProviderId, providerFor);

  return {
    list: providerIds,
    capabilities: Effect.map(activeProvider, (provider) => provider.capabilities),
    select: (plan) => (plan === undefined ? activeProvider : providerFor(plan.provider)),
  };
};

export { RuntimeProviderRegistry };

export const RuntimeProviderRegistryLive = Layer.effect(
  RuntimeProviderRegistry,
  Effect.gen(function* () {
    const configService = yield* ConfigService;
    const pluginRegistry = yield* PluginRegistry;
    const eventService = yield* Effect.serviceOption(EventService);
    const downloader = yield* Downloader;
    const landoPaths = yield* PathsService;
    const logFileHelperPayloads = yield* loadLogFileHelperPayloads();
    return makeRuntimeProviderRegistry(
      configService,
      pluginRegistry,
      eventService._tag === "Some" ? eventService.value : undefined,
      downloader,
      landoPaths,
      logFileHelperPayloads,
    );
  }),
);

export const LandoRuntimeProviderLive = Layer.effect(
  RuntimeProvider,
  loadLogFileHelperPayloads().pipe(
    Effect.flatMap((logFileHelperPayloads) => makeLandoRuntimeProvider({ logFileHelperPayloads })),
    Effect.mapError(toProviderUnavailableFromCapability),
  ),
);
export const DockerRuntimeProviderLive = Layer.effect(
  RuntimeProvider,
  loadLogFileHelperPayloads().pipe(
    Effect.flatMap((logFileHelperPayloads) => makeDockerRuntimeProvider({ logFileHelperPayloads })),
    Effect.mapError(toProviderUnavailableFromCapability),
  ),
);
