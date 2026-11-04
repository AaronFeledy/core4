import type { InstalledPluginRegistryEntry } from "@lando/engine/plugins/installed-registry";
import type { StateStoreShape } from "@lando/sdk/services";
import type { NpmRegistryTransport, SourceSession, SourceStore } from "@lando/source-acquisition";
import type { InteractionPrompter } from "../../interaction/prompter";

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
  /** Content-addressed source cache root; defaults to paths.sourceCacheDir. */
  readonly sourceCacheRoot?: string;
  readonly registryUrl?: string;
  /** Use an existing store or session instead of constructing a source store. */
  readonly sources?: SourceStore | SourceSession;
  readonly npmRegistry?: NpmRegistryTransport;
  /** State store for makeSourceStore when `sources` is omitted. */
  readonly stateStore?: StateStoreShape;
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
