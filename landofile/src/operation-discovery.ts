import { isPathWithin } from "@lando/paths";
import { PathsService } from "@lando/sdk/services";
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

const operationResolver = Effect.fnUntraced(function* () {
  const paths = yield* Effect.serviceOption(PathsService);
  return makeAppDiscoveryResolver(
    paths._tag === "None"
      ? undefined
      : {
          exists: (path) => Bun.file(path).exists(),
          excluded: (directory) =>
            directory === paths.value.globalAppRoot || isPathWithin(paths.value.scratchDir, directory),
        },
  );
});

export const discoverForOperation = Effect.fnUntraced(function* (cwd?: string) {
  const provided = yield* Effect.serviceOption(OperationDiscovery);
  const operation = provided._tag === "Some" ? provided.value : currentDiscoveryOperation();
  const directory = cwd ?? operation?.cwd ?? process.cwd();
  const resolver = operation?.resolver ?? (yield* operationResolver());
  return yield* Effect.promise(() => resolver.resolve(directory));
});

export const withAppDiscovery = Effect.fnUntraced(function* <A, E, R>(
  cwd: string,
  effect: Effect.Effect<A, E, R>,
) {
  const resolver = yield* operationResolver();
  return yield* effect.pipe(
    Effect.provideService(OperationDiscovery, {
      cwd,
      resolver,
    }),
  );
});

export const withDiscoveryCwd = Effect.fnUntraced(function* <A, E, R>(
  cwd: string,
  effect: Effect.Effect<A, E, R>,
) {
  const provided = yield* Effect.serviceOption(OperationDiscovery);
  const operation = provided._tag === "Some" ? provided.value : currentDiscoveryOperation();
  return yield* effect.pipe(
    Effect.provideService(OperationDiscovery, {
      cwd,
      resolver: operation?.resolver ?? (yield* operationResolver()),
    }),
  );
});
