import { Effect, Schema } from "effect";

import { PLUGIN_NAME as LANDO_PROVIDER_PLUGIN_NAME } from "@lando/provider-lando";
import { AbsolutePath } from "@lando/sdk/schema";
import type { StateStoreShape } from "@lando/sdk/services";

import type { LandoPaths } from "../config/paths.ts";
import { makePluginStateStore } from "../plugins/context-state.ts";

export const makeLandoRuntimeState = (stateStore: StateStoreShape, paths: LandoPaths) => {
  const providerState = makePluginStateStore(
    stateStore,
    Schema.decodeUnknownSync(AbsolutePath)(paths.pluginStateDir(LANDO_PROVIDER_PLUGIN_NAME)),
  );
  const generationBucket = providerState.open({
    key: "runtime-generation.json",
    schema: Schema.String,
    version: 1,
    lock: "advisory",
    onCorrupt: "fail",
    onVersionMismatch: "discard",
  });
  return {
    runtimeLock: <A, E>(body: Effect.Effect<A, E>) => providerState.withLock("runtime-launch", body),
    runtimeGenerationStore: {
      get: generationBucket.pipe(Effect.flatMap((bucket) => bucket.get)),
      set: (generation: string) => generationBucket.pipe(Effect.flatMap((bucket) => bucket.set(generation))),
    },
  };
};
