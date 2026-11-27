export * from "@lando/state-store/testing";

import type { RuntimeProviderShape } from "@lando/sdk/services";
import { makeTestStateStore } from "@lando/state-store/testing";
import { Effect } from "effect";

export const withTestVolumeLocks = (provider: RuntimeProviderShape): RuntimeProviderShape => {
  const { layer } = makeTestStateStore();
  const cleanup = provider.cleanupOwnedResources;
  return {
    ...provider,
    bringDown: (target, options) => provider.bringDown(target, options).pipe(Effect.provide(layer)),
    ...(cleanup === undefined
      ? {}
      : {
          cleanupOwnedResources: (root, options) => cleanup(root, options).pipe(Effect.provide(layer)),
        }),
  };
};
