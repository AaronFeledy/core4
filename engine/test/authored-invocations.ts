import type { AppPlan, LandofileEvents } from "@lando/sdk/schema";
import { PluginRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer } from "effect";
import { effectiveToolingForPlan } from "../src/planner/effective-tooling.ts";
import * as Registry from "../src/plugins/registry.ts";
import { compileTestLandofile } from "./compiled-landofile.ts";
import { planApp } from "./plan-app.ts";

export const compileAuthoredEventPlan = (plan: AppPlan, events: LandofileEvents) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const tooling = effectiveToolingForPlan(plan);
      const loaded = yield* compileTestLandofile(
        { name: plan.name, events, ...(tooling === undefined ? {} : { tooling }) },
        String(plan.root),
      );
      const registry = yield* PluginRegistry;
      const compiled = yield* planApp(
        { landofile: loaded, providerCapabilities: TestRuntimeProvider.capabilities },
        Layer.succeed(PluginRegistry, registry),
      );
      return {
        ...plan,
        ...(compiled.events === undefined ? {} : { events: compiled.events }),
        extensions: { ...plan.extensions, ...compiled.extensions },
      };
    }).pipe(Effect.provide(Registry.layerWith({ bundled: false }, []))),
  );
