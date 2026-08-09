import { type Context, Effect, Layer, Scope } from "effect";

import type { App, AppSelector, LandoRuntime, ScratchAcquireError } from "@lando/sdk/app";
import {
  type AppResolveError,
  type ConfigError,
  type LandoRuntimeBootstrapError,
  LandofileParseError,
  ScratchAppError,
} from "@lando/sdk/errors";
import { AbsolutePath } from "@lando/sdk/schema";
import { type ScratchAcquireInput, ScratchAppService } from "@lando/sdk/services";

import type { AppHandleRuntimeServices } from "@lando/engine/app/handle";
import { type ResolvedAppTarget, withResolvedCwd } from "@lando/engine/landofile/app-resolution";
import type { RuntimeCwd } from "@lando/engine/runtime/cwd";
import { ScratchRegistryLive } from "@lando/engine/scratch-app/registry";
import { ScratchResourceScannerLive } from "@lando/engine/scratch-app/scanner";
import { ScratchAppServiceLive, acquireScratchAppWithPlan } from "@lando/engine/scratch-app/service";
import { type LandoRuntimeOptions, makeLandoRuntime } from "../runtime/layer";
import { ScratchInitAppPortLive } from "../runtime/scratch-init-port.ts";
import { buildAppHandle, resolveApp } from "./resolve";

type RuntimeContext = Context.Context<AppHandleRuntimeServices | ScratchAppService | RuntimeCwd>;

/**
 * Options for {@link openLandoRuntime}. Extends the runtime layer options with
 * an optional `scratch` construction: when present, the runtime acquires one
 * scratch app in the caller's scope and `runtime.app()` resolves to it by default.
 */
export type OpenLandoRuntimeOptions = LandoRuntimeOptions & {
  readonly scratch?: ScratchAcquireInput;
};

/**
 * Acquires one Lando runtime in the caller's `Scope` and returns an object whose
 * `app`, `scratch`, and `run` methods are bound to that retained runtime. The
 * runtime tears down when the caller's scope closes. A no-selector `app()` call
 * resolves from the construction-time `cwd` (captured once), or the acquired
 * scratch app when the runtime is constructed with `scratch`.
 */
export const openLandoRuntime = (
  options: OpenLandoRuntimeOptions,
): Effect.Effect<LandoRuntime, ConfigError | LandoRuntimeBootstrapError | ScratchAcquireError, Scope.Scope> =>
  Effect.gen(function* () {
    const { scratch: scratchInput, ...runtimeOptions } = options;
    const capturedCwd = AbsolutePath.make(runtimeOptions.cwd ?? process.cwd());
    const appLayer = makeLandoRuntime({ bootstrap: "app", ...runtimeOptions } as LandoRuntimeOptions & {
      readonly bootstrap: "app";
    });
    const scratchDeps = Layer.mergeAll(
      appLayer,
      ScratchRegistryLive,
      ScratchResourceScannerLive,
      ScratchInitAppPortLive,
    );
    const layer = Layer.mergeAll(
      appLayer,
      ScratchRegistryLive,
      ScratchResourceScannerLive,
      ScratchInitAppPortLive,
      ScratchAppServiceLive.pipe(Layer.provide(scratchDeps)),
    );
    const context: RuntimeContext = yield* Layer.build(layer);
    const runtimeScope = yield* Effect.scope;

    const defaultTarget: ResolvedAppTarget | undefined =
      scratchInput === undefined
        ? undefined
        : yield* withResolvedCwd(
            capturedCwd,
            Effect.suspend(() => acquireScratchAppWithPlan(scratchInput)),
          ).pipe(
            Effect.map(({ handle, plan }) => ({ plan, root: plan.root, app: handle.app })),
            Effect.mapError((cause) =>
              cause instanceof LandofileParseError
                ? new ScratchAppError({
                    message: `Unable to acquire scratch app from runtime cwd ${capturedCwd}.`,
                    operation: "acquire",
                    cause,
                  })
                : cause,
            ),
            Effect.provide(context),
          );

    const run = ((program: Effect.Effect<unknown, unknown, unknown>) =>
      Effect.provide(program, context)) as LandoRuntime["run"];

    const app = (selector?: AppSelector): Effect.Effect<App, AppResolveError> => {
      if (selector === undefined && defaultTarget !== undefined) {
        return buildAppHandle(defaultTarget).pipe(
          Effect.provideService(Scope.Scope, runtimeScope),
          Effect.provide(context),
        );
      }
      return resolveApp(selector ?? { cwd: capturedCwd }).pipe(
        Effect.provideService(Scope.Scope, runtimeScope),
        Effect.provide(context),
      );
    };

    return {
      app,
      scratch: (input) =>
        ScratchAppService.pipe(
          Effect.flatMap((service) => service.acquire(input)),
          Effect.provide(context),
        ),
      run,
    };
  });
