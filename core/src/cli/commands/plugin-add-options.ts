import type { InstalledPluginRegistryEntry } from "@lando/engine/plugins/installed-registry";
import type { InteractionPrompter } from "../../interaction/prompter";
import type { NpmRegistryClient } from "../../recipes/npm-source";
import type { TarballRecipeExtractor, TarballRecipeFetcher } from "../../recipes/tarball-source";

export interface PluginAddPrompter {
  readonly confirmTrust: (request: {
    readonly pluginName: string;
    readonly spec: string;
  }) => Promise<boolean>;
}
export type PluginTrustStore = Set<string>;
export interface PluginAddOptions {
  readonly spec: string;
  readonly trust?: boolean;
  readonly nonInteractive?: boolean;
  readonly pluginsRoot?: string;
  readonly userDataRoot?: string;
  readonly cacheRoot?: string;
  readonly registryUrl?: string;
  readonly registryClient?: NpmRegistryClient;
  readonly fetcher?: TarballRecipeFetcher;
  readonly extractor?: TarballRecipeExtractor;
  readonly prompter?: PluginAddPrompter;
  readonly interaction?: InteractionPrompter;
  readonly trustStore?: PluginTrustStore;
  readonly requestedSelector?: string;
  readonly expectedManifest?: {
    readonly name: string;
    readonly version: string;
    readonly requires?: Readonly<Record<string, string>>;
  };
  readonly expectedActivation?: InstalledPluginRegistryEntry;
  readonly expectedRegistry?: Readonly<Record<string, InstalledPluginRegistryEntry>>;
}
