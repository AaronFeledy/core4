import { Context, type Effect } from "effect";

import type { PluginManifest } from "@lando/sdk/schema";

export interface GlobalPluginManifestsShape {
  readonly list: Effect.Effect<ReadonlyArray<PluginManifest>>;
}

export class GlobalPluginManifests extends Context.Service<
  GlobalPluginManifests,
  GlobalPluginManifestsShape
>()("@lando/engine/GlobalPluginManifests") {}
