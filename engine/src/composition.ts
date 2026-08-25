import type { LandofileRuntimeInputs } from "@lando/landofile/ports";
import type { HostProxyTransportUnavailableError } from "@lando/sdk/errors";
import type { LandoPluginModule } from "@lando/sdk/plugins";
import type { Effect } from "effect";

import type { HostProxyShimTarget } from "./subsystems/host-proxy/transport-shim.ts";

export interface EngineCompositionInputs {
  readonly bundledPluginModules: ReadonlyArray<LandoPluginModule>;
  readonly builtInCommandIds: ReadonlyArray<string>;
  readonly landofileRuntimeInputs: LandofileRuntimeInputs;
  readonly hostProxyWorkerEntry: () => HostProxyWorkerEntry;
  readonly bunDevDistRoot: () => string;
  readonly prepareHostProxyShimArtifact: (
    target: HostProxyShimTarget,
  ) => Effect.Effect<string, HostProxyTransportUnavailableError>;
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

export const hostProxyWorkerEntry = (): HostProxyWorkerEntry => requireComposition().hostProxyWorkerEntry();

export const bunDevDistRoot = (): string => requireComposition().bunDevDistRoot();

export const prepareHostProxyShimArtifact = (
  target: HostProxyShimTarget,
): Effect.Effect<string, HostProxyTransportUnavailableError> =>
  requireComposition().prepareHostProxyShimArtifact(target);
