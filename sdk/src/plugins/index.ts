/**
 * `@lando/sdk/plugins` — plugin-author contracts for manifests, subscribers, and
 * the constrained plugin context (including the closed `publishRender` seam).
 */
import type { Effect } from "effect";

import type { EventError } from "../errors/index.ts";
import type { LandoEvent, RenderEvent } from "../events/index.ts";
import type { PluginManifest } from "../schema/plugin.ts";
import type { AbsolutePath } from "../schema/primitives.ts";
import type { SubscriberManifestEntry } from "../schema/subscriber.ts";

export type {
  PluginContribution,
  PluginManifest,
  PluginSetupContribution,
  PluginSetupFlagContribution,
} from "../schema/plugin.ts";
export type {
  PublishedGlobalConfigKey,
  SubscriberManifestEntry,
  SubscriberSelector,
} from "../schema/subscriber.ts";
export type {
  RendererPanel,
  RendererPanelId,
  RendererPanelManifestEntry,
  RendererPanelSlot,
  RendererPanelWatch,
} from "../schema/renderer-panel.ts";
export type { RenderEvent } from "../events/rich-render.ts";

/**
 * Constrained publish-only seam onto the closed `RenderEvent` vocabulary.
 * Implementations redact and schema-decode before handing the event to the
 * internal `EventService`. Plugins never receive the full event bus.
 */
export type PublishRender = (event: RenderEvent) => Effect.Effect<void, EventError>;

/**
 * Plugin-scoped managed-file and state surfaces. Core fills these with
 * id-scoped adapters; the shapes stay contract-only here.
 */
export interface PluginManagedFiles {
  readonly pluginId: string;
}

export interface PluginStateStore {
  readonly open: (spec: {
    readonly id: string;
    readonly schema: unknown;
    readonly root?: { readonly path: AbsolutePath };
  }) => Effect.Effect<unknown, unknown>;
}

/**
 * Constrained context every plugin contribution receives.
 * `events.publishRender` is the only publication seam onto render events.
 */
export interface LandoPluginContext {
  readonly id: string;
  readonly managedFiles: PluginManagedFiles;
  readonly stateStore: PluginStateStore;
  readonly events: {
    readonly publishRender: PublishRender;
  };
}

/**
 * Subscriber module default export. Receives the plugin context plus an
 * optional already-decoded global-config slice (`configKey` projection).
 * Returns a handler invoked for each matching event. The factory runs once
 * (lazily, on first match) and the handler is cached.
 */
export type SubscriberFactory<Config = undefined> = (
  ctx: LandoPluginContext,
  config: Config,
) => (event: LandoEvent) => Effect.Effect<void, EventError>;

/** Convenience alias for a decoded subscribers array on a manifest. */
export type PluginSubscribers = ReadonlyArray<SubscriberManifestEntry>;

/** Re-export the manifest type for plugin-author imports from this subpath. */
export type { PluginManifest as PluginManifestContract };
