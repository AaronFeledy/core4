import { Context, Effect } from "effect";
import { currentDiscoveryOperation } from "./operation-scope.ts";
import { type AppDiscoveryResolver, makeAppDiscoveryResolver } from "./traversal-policy.ts";

export class OperationDiscovery extends Context.Service<
  OperationDiscovery,
  {
    readonly cwd: string;
    readonly resolver: AppDiscoveryResolver;
  }
>()("@lando/landofile/OperationDiscovery") {}

export const discoveryCwd = Effect.fnUntraced(function* () {
  const operation = yield* Effect.serviceOption(OperationDiscovery);
  return operation._tag === "Some"
    ? operation.value.cwd
    : (currentDiscoveryOperation()?.cwd ?? process.cwd());
});

export const discoverForOperation = Effect.fnUntraced(function* (cwd?: string) {
  const provided = yield* Effect.serviceOption(OperationDiscovery);
  const operation = provided._tag === "Some" ? provided.value : currentDiscoveryOperation();
  const directory = cwd ?? operation?.cwd ?? process.cwd();
  const resolver = operation?.resolver ?? makeAppDiscoveryResolver();
  return yield* Effect.promise(() => resolver.resolve(directory));
});

export const withAppDiscovery = <A, E, R>(
  cwd: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, OperationDiscovery>> =>
  Effect.suspend(() =>
    effect.pipe(
      Effect.provideService(OperationDiscovery, {
        cwd,
        resolver: makeAppDiscoveryResolver(),
      }),
    ),
  );

export const withDiscoveryCwd = Effect.fnUntraced(function* <A, E, R>(
  cwd: string,
  effect: Effect.Effect<A, E, R>,
) {
  const provided = yield* Effect.serviceOption(OperationDiscovery);
  const operation = provided._tag === "Some" ? provided.value : currentDiscoveryOperation();
  return yield* effect.pipe(
    Effect.provideService(OperationDiscovery, {
      cwd,
      resolver: operation?.resolver ?? makeAppDiscoveryResolver(),
    }),
  );
});
