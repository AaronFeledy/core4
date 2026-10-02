import { realpath } from "node:fs/promises";

import { Context, Effect, Layer, Option } from "effect";

import { StateStoreError } from "@lando/sdk/errors";
import type { AppRef } from "@lando/sdk/schema";

export class AppRootIdentity extends Context.Tag("@lando/engine/AppRootIdentity")<
  AppRootIdentity,
  { readonly canonicalRoot: (root: string) => Effect.Effect<string, StateStoreError> }
>() {}

export class PinnedAppRoot extends Context.Tag("@lando/engine/PinnedAppRoot")<
  PinnedAppRoot,
  { readonly requestedRoot: string; readonly canonicalRoot: string }
>() {}

export const AppRootIdentityLive = Layer.succeed(AppRootIdentity, {
  canonicalRoot: (root: string) =>
    Effect.tryPromise({
      try: () => realpath(root),
      catch: (cause) =>
        new StateStoreError({
          reason: "path",
          operation: "canonicalAppRoot",
          path: root,
          cause,
          remediation: "Check that the app root exists and can be resolved, then retry.",
        }),
    }),
});

export const canonicalAppRoot = (root: string) =>
  Effect.gen(function* () {
    const pinned = yield* Effect.serviceOption(PinnedAppRoot);
    if (Option.isSome(pinned) && pinned.value.requestedRoot === root) {
      return pinned.value.canonicalRoot;
    }
    const identity = yield* Effect.serviceOption(AppRootIdentity);
    return yield* Option.isSome(identity)
      ? identity.value.canonicalRoot(root)
      : AppRootIdentity.pipe(
          Effect.flatMap((live) => live.canonicalRoot(root)),
          Effect.provide(AppRootIdentityLive),
        );
  });

export const appRootIdentityKey = (app: AppRef, canonicalRoot: string) =>
  JSON.stringify([app.kind, canonicalRoot]);
