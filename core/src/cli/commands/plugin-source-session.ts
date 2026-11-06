import { PluginPackageOperationError } from "@lando/sdk/errors";
import { StateStore } from "@lando/sdk/services";
import { type SourceSession, makeSourceStore } from "@lando/source-acquisition";
import { Effect, Option } from "effect";
import { retainedRecipeSourceStore } from "../../recipes/runtime-sources";
import type { PluginAddOptions } from "./plugin-add-options";

export const withPluginSourceSession = <A, E, R>(
  options: PluginAddOptions,
  body: (session: SourceSession) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      if (options.sources !== undefined && !("session" in options.sources))
        return yield* body(options.sources);
      const store = yield* Effect.gen(function* () {
        if (options.sources !== undefined && "session" in options.sources) return options.sources;
        if (options.npmRegistry === undefined)
          return (yield* retainedRecipeSourceStore(options.registryUrl)).store;
        const state = yield* Effect.serviceOption(StateStore);
        const stateStore = options.stateStore ?? Option.getOrUndefined(state);
        if (stateStore === undefined)
          return yield* Effect.fail(
            new PluginPackageOperationError({
              message: "Plugin source acquisition requires StateStore.",
              commandId: "meta:plugin:add",
              operation: "resolve",
              packageSpec: options.spec,
              cwd: options.pluginsRoot ?? "",
              remediation:
                "Provide a scoped source store or the StateStore service before installing plugins.",
            }),
          );
        return makeSourceStore({ stateStore, transports: { npmRegistry: options.npmRegistry } });
      });
      const session = yield* store.session.pipe(
        Effect.mapError(
          (error) =>
            new PluginPackageOperationError({
              message: `Plugin package resolve failed for ${options.spec}.`,
              commandId: "meta:plugin:add",
              operation: "resolve",
              packageSpec: options.spec,
              cwd: options.pluginsRoot ?? "",
              detail: error.message,
              remediation: error.remediation,
            }),
        ),
      );
      return yield* body(session);
    }),
  );
