import type { PluginManifest } from "@lando/sdk/schema";
import { Context, type Effect } from "effect";

export interface GlobalPluginManifestsShape {
  readonly list: Effect.Effect<ReadonlyArray<PluginManifest>>;
}

export class GlobalPluginManifests extends Context.Service<
  GlobalPluginManifests,
  GlobalPluginManifestsShape
>()("@lando/engine/GlobalPluginManifests") {}
