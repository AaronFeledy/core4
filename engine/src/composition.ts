import type { LandofileRuntimeInputs } from "@lando/landofile/ports";
import type { ContainerHelperUnavailableError } from "@lando/sdk/errors";
import type { LandoPluginModule } from "@lando/sdk/plugins";
import type { ContainerHelperArtifact, ContainerHelperTarget } from "@lando/sdk/schema";
import type { Downloader } from "@lando/sdk/services";
import type { Effect } from "effect";
import type * as HttpClient from "effect/http/HttpClient";
import type { HostConfigReadPolicy } from "./services/config.ts";

export interface EngineCompositionInputs {
  readonly bundledPluginModules: ReadonlyArray<LandoPluginModule>;
  readonly builtInCommandIds: ReadonlyArray<string>;
  readonly landofileRuntimeInputs: LandofileRuntimeInputs;
  readonly landofileSourcePorts: (
    client: HttpClient.HttpClient,
    downloader: typeof Downloader.Service,
    runtime?: LandofileSourcePortRuntime,
  ) => Pick<LandofileRuntimeInputs["ports"], "npmRecipeSource" | "tarball">;
  readonly hostProxyWorkerEntry: () => HostProxyWorkerEntry;
  readonly resolveContainerHelper: (
    target: ContainerHelperTarget,
    options: { readonly cacheRoot: string },
  ) => Effect.Effect<ContainerHelperArtifact, ContainerHelperUnavailableError>;
}

/** Runtime capabilities that host-side source acquisition must honor. */
export interface LandofileSourcePortRuntime {
  readonly registerSecrets?: (values: ReadonlyArray<string>) => Promise<void>;
  readonly readPolicy?: HostConfigReadPolicy;
}

export interface HostProxyWorkerEntry {
  readonly execPath: string;
  readonly entryPath: string | undefined;
  readonly bunSourceEntryPath: string;
}

declare global {
  var __landoEngineCompositionInputs: EngineCompositionInputs | undefined;
}

export const installEngineComposition = (inputs: EngineCompositionInputs): void => {
  globalThis.__landoEngineCompositionInputs = inputs;
};

export const installEngineCompositionIfAbsent = (inputs: EngineCompositionInputs): void => {
  globalThis.__landoEngineCompositionInputs ??= inputs;
};

const requireComposition = (): EngineCompositionInputs => {
  const installed = globalThis.__landoEngineCompositionInputs;
  if (installed !== undefined) return installed;
  throw new TypeError("Engine composition inputs have not been installed by the host package.");
};

export const bundledPluginModules = (): ReadonlyArray<LandoPluginModule> =>
  requireComposition().bundledPluginModules;

export const builtInCommandIds = (): ReadonlyArray<string> => requireComposition().builtInCommandIds;

export const landofileRuntimeInputs = (): LandofileRuntimeInputs =>
  requireComposition().landofileRuntimeInputs;

export const landofileSourcePorts = (
  client: HttpClient.HttpClient,
  downloader: typeof Downloader.Service,
  runtime?: LandofileSourcePortRuntime,
) => requireComposition().landofileSourcePorts(client, downloader, runtime);

export const hostProxyWorkerEntry = (): HostProxyWorkerEntry => requireComposition().hostProxyWorkerEntry();

export const resolveContainerHelper = (
  target: ContainerHelperTarget,
  options: { readonly cacheRoot: string },
): Effect.Effect<ContainerHelperArtifact, ContainerHelperUnavailableError> =>
  requireComposition().resolveContainerHelper(target, options);
