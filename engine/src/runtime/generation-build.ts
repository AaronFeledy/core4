import { PathsService } from "@lando/sdk/services";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { bundledPluginModules } from "../composition.ts";
import { pluginImplementationIdentity } from "../plugins/implementation-identity.ts";
import { PluginManifestResolution } from "../plugins/manifest-resolution.ts";
import { pluginLoadError } from "../plugins/plugin-module-path.ts";
import {
  type PluginSelection,
  type PluginSelectionPolicy,
  resolvePluginSelection,
} from "../plugins/selection.ts";
import {
  EventDispatchControl,
  EventDispatchScope,
  makeScopedEventDispatch,
} from "../services/event-service.ts";

export interface GenerationBuilderInput<Host, Services, Record, Failure> {
  readonly policy: PluginSelectionPolicy;
  readonly host: Context.Context<Host | PathsService>;
  readonly build: (input: {
    readonly cwd: string;
    readonly host: Context.Context<Host | PathsService | PluginManifestResolution | EventDispatchControl>;
  }) => Layer.Layer<Services, Failure, unknown>;
  readonly project: (record: {
    readonly key: string;
    readonly context: Context.Context<Services>;
  }) => Effect.Effect<Record, Failure>;
}

export const makeGenerationBuilder = <Host, Services, Record, Failure>(
  input: GenerationBuilderInput<Host, Services, Record, Failure>,
) => {
  const build = Effect.fnUntraced(function* (key: string, selection: PluginSelection, scope: Scope.Scope) {
    const dispatch = makeScopedEventDispatch();
    const minimal = input.host.pipe(
      Context.add(PluginManifestResolution, selection.resolution),
      Context.add(EventDispatchControl, dispatch.control),
    );
    const attemptScope = yield* Scope.fork(scope);
    const context = yield* Layer.buildWithMemoMap(
      input.build({ cwd: key, host: minimal }),
      Layer.makeMemoMapUnsafe(),
      attemptScope,
    ).pipe(Effect.provide(Context.makeUnsafe<unknown>(minimal.mapUnsafe)));
    const record = yield* input.project({
      key,
      context: Context.add(context, EventDispatchScope, dispatch.registration),
    });
    const after = yield* Effect.tryPromise({
      try: () =>
        Promise.all(
          selection.implementations.map((implementation) =>
            pluginImplementationIdentity(implementation.realpath),
          ),
        ),
      catch: (cause) =>
        pluginLoadError(
          "app-generation",
          "Failed to inspect loaded plugin implementations",
          cause,
          "Retry after the plugin edit settles.",
        ),
    });
    return {
      record,
      stable: after.every(
        (implementation, index) => implementation.identity === selection.implementations[index]?.identity,
      ),
      attemptScope,
    };
  });

  return Effect.fnUntraced(function* (key: string, selection: PluginSelection, scope: Scope.Scope) {
    const first = yield* build(key, selection, scope);
    if (first.stable) return { record: first.record, selection };
    yield* Scope.close(first.attemptScope, Exit.void);
    const refreshed = yield* resolvePluginSelection({
      policy: input.policy,
      roots: Context.get(input.host, PathsService),
      modules: bundledPluginModules(),
      appRoot: key,
    });
    const second = yield* build(key, refreshed, scope);
    if (second.stable) return { record: second.record, selection: refreshed };
    return yield* Effect.fail(
      pluginLoadError(
        "app-generation",
        "Plugin implementation changed during both generation builds",
        undefined,
        "Retry after the plugin edit settles.",
      ),
    );
  });
};
