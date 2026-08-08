import { Context, type Effect } from "effect";

import type { PluginManifest } from "@lando/sdk/schema";

export interface GlobalPluginManifestsShape {
  readonly list: Effect.Effect<ReadonlyArray<PluginManifest>>;
}

export class GlobalPluginManifests extends Context.Tag("@lando/core/GlobalPluginManifests")<
  GlobalPluginManifests,
  GlobalPluginManifestsShape
>() {}
