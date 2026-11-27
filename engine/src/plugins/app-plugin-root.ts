import { Context, Effect } from "effect";

/** An explicit selection scope: an exact admitted root, or no app registry at all. */
export class AppPluginRoot extends Context.Service<
  AppPluginRoot,
  { readonly current: Effect.Effect<string | undefined> }
>()("@lando/engine/AppPluginRoot") {}

/** Check again after manifest I/O, before a selected module can run. Only a refusal retries selection. */
export const resolveAtPinnedApp = Effect.fnUntraced(function* <A, E, R>(
  { current }: typeof AppPluginRoot.Service,
  resolve: (root: string | undefined) => Effect.Effect<A, E, R>,
) {
  const root = yield* current;
  const selection = yield* resolve(root);
  return root !== undefined && (yield* current) !== root ? yield* resolve(undefined) : selection;
});
