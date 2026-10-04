import { realpath } from "node:fs/promises";

import { Context, Effect, Layer, Option } from "effect";

import { StateStoreError } from "@lando/sdk/errors";
import type { AppRef } from "@lando/sdk/schema";

export class AppRootIdentity extends Context.Service<
  AppRootIdentity,
  { readonly canonicalRoot: (root: string) => Effect.Effect<string, StateStoreError> }
>()("@lando/engine/AppRootIdentity") {
  static readonly layer = Layer.succeed(
    this,
    this.of({
      canonicalRoot: Effect.fn("AppRootIdentity.canonicalRoot")(function* (root: string) {
        return yield* Effect.tryPromise({
          try: () => realpath(root),
          catch: (cause) =>
            new StateStoreError({
              reason: "path",
              operation: "canonicalAppRoot",
              path: root,
              cause,
              remediation: "Check that the app root exists and can be resolved, then retry.",
            }),
        });
      }),
    }),
  );
}

export class PinnedAppRoot extends Context.Service<
  PinnedAppRoot,
  { readonly requestedRoot: string; readonly canonicalRoot: string }
>()("@lando/engine/PinnedAppRoot") {}

export const canonicalAppRoot = Effect.fnUntraced(function* (root: string) {
  const pinned = yield* Effect.serviceOption(PinnedAppRoot);
  if (Option.isSome(pinned) && pinned.value.requestedRoot === root) {
    return pinned.value.canonicalRoot;
  }
  const identity = yield* Effect.serviceOption(AppRootIdentity);
  return yield* Option.isSome(identity)
    ? identity.value.canonicalRoot(root)
    : AppRootIdentity.pipe(
        Effect.flatMap((live) => live.canonicalRoot(root)),
        Effect.provide(AppRootIdentity.layer),
      );
});

export const appRootIdentityKey = (app: AppRef, canonicalRoot: string) =>
  JSON.stringify([app.kind, canonicalRoot]);
