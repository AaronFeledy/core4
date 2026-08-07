import type { LandofileRuntimeInputs } from "@lando/landofile/ports";
import type { LandoPluginModule } from "@lando/sdk/plugins";

export interface EngineCompositionInputs {
  readonly bundledPluginModules: ReadonlyArray<LandoPluginModule>;
  readonly builtInCommandIds: ReadonlyArray<string>;
  readonly landofileRuntimeInputs: LandofileRuntimeInputs;
  readonly hostProxyWorkerEntry: () => HostProxyWorkerEntry;
  readonly bunDevDistRoot: () => string;
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
