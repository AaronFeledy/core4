import { type Context, Effect, Layer, type Scope } from "effect";

import type { AppSelector, LandoRuntime, LandoRuntimeServices } from "@lando/sdk/app";
import type { LandoRuntimeBootstrapError } from "@lando/sdk/errors";
import { ScratchAppService } from "@lando/sdk/services";

import { type LandoRuntimeOptions, makeLandoRuntime } from "../runtime/layer.ts";
import { ScratchRegistryLive } from "../scratch-app/registry.ts";
import { ScratchResourceScannerLive } from "../scratch-app/scanner.ts";
import { ScratchAppServiceLive } from "../scratch-app/service.ts";
import { resolveApp } from "./resolve.ts";

type RuntimeContext = Context.Context<LandoRuntimeServices | ScratchAppService>;

/**
 * Acquires one Lando runtime in the caller's `Scope` and returns an object whose
 * `app`, `scratch`, and `run` methods are bound to that retained runtime.
 * The runtime tears down when the caller's scope closes.
 */
export const openLandoRuntime = (
  options: LandoRuntimeOptions,
): Effect.Effect<LandoRuntime, LandoRuntimeBootstrapError, Scope.Scope> =>
  Effect.gen(function* () {
    const appLayer = makeLandoRuntime({ bootstrap: "app", ...options } as LandoRuntimeOptions & {
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

    const run = ((program: Effect.Effect<unknown, unknown, unknown>) =>
      Effect.provide(program, context)) as LandoRuntime["run"];

    return {
      app: (selector?: AppSelector) => resolveApp(selector).pipe(Effect.provide(context)),
      scratch: (input) =>
        ScratchAppService.pipe(
          Effect.flatMap((service) => service.acquire(input)),
          Effect.provide(context),
        ),
      run,
    };
  });
