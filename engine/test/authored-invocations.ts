import type { AppPlan, LandofileEvents } from "@lando/sdk/schema";
import { PluginRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect } from "effect";
import { planApp } from "../src/planner/assemble.ts";
import { effectiveToolingForPlan } from "../src/planner/effective-tooling.ts";
import { carryPlanAttachments } from "../src/planner/plan-attachments.ts";
import * as Registry from "../src/plugins/registry.ts";
import { compileTestLandofile } from "./compiled-landofile.ts";

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
        registry,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        loaded,
        TestRuntimeProvider.capabilities,
      );
      return carryPlanAttachments(compiled, plan);
    }).pipe(Effect.provide(Registry.layerWith({ bundled: false }, []))),
  );
