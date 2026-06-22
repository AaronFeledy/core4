import { type Context, Effect, Layer, type Scope } from "effect";

import type {
  App,
  AppSelector,
  LandoRuntime,
  LandoRuntimeServices,
  ScratchAcquireError,
} from "@lando/sdk/app";
import type { AppResolveError, LandoRuntimeBootstrapError } from "@lando/sdk/errors";
import type { AbsolutePath } from "@lando/sdk/schema";
import { type ScratchAcquireInput, ScratchAppService } from "@lando/sdk/services";

import type { ResolvedAppTarget } from "../cli/app-resolution.ts";
import { type LandoRuntimeOptions, makeLandoRuntime } from "../runtime/layer.ts";
import { ScratchRegistryLive } from "../scratch-app/registry.ts";
import { ScratchResourceScannerLive } from "../scratch-app/scanner.ts";
import { ScratchAppServiceLive, acquireScratchAppWithPlan } from "../scratch-app/service.ts";
import { buildAppHandle, resolveApp } from "./resolve.ts";

type RuntimeContext = Context.Context<LandoRuntimeServices | ScratchAppService>;

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
): Effect.Effect<LandoRuntime, LandoRuntimeBootstrapError | ScratchAcquireError, Scope.Scope> =>
  Effect.gen(function* () {
    const { scratch: scratchInput, ...runtimeOptions } = options;
    const capturedCwd = (runtimeOptions.cwd ?? process.cwd()) as AbsolutePath;
    const appLayer = makeLandoRuntime({ bootstrap: "app", ...runtimeOptions } as LandoRuntimeOptions & {
      readonly bootstrap: "app";
    });
    const scratchDeps = Layer.mergeAll(appLayer, ScratchRegistryLive, ScratchResourceScannerLive);
    const layer = Layer.mergeAll(
      appLayer,
      ScratchRegistryLive,
      ScratchResourceScannerLive,
      ScratchAppServiceLive.pipe(Layer.provide(scratchDeps)),
    );
    const context = (yield* Layer.build(layer)) as unknown as RuntimeContext;

    const defaultTarget: ResolvedAppTarget | undefined =
      scratchInput === undefined
        ? undefined
        : yield* acquireScratchAppWithPlan(scratchInput).pipe(
            Effect.map(({ handle, plan }) => ({ plan, root: plan.root, app: handle.app })),
            Effect.provide(context),
          );

    const run = ((program: Effect.Effect<unknown, unknown, unknown>) =>
      Effect.provide(program, context)) as LandoRuntime["run"];

    const app = (selector?: AppSelector): Effect.Effect<App, AppResolveError> => {
      if (selector === undefined && defaultTarget !== undefined) {
        return buildAppHandle(defaultTarget).pipe(Effect.provide(context));
      }
      return resolveApp(selector ?? { cwd: capturedCwd }).pipe(Effect.provide(context));
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
