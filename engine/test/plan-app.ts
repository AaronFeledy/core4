import type { PluginRegistry } from "@lando/sdk/services";
import { Effect, Layer } from "effect";
import { type PlanAppInput, planApp as assemble } from "../src/planner/assemble.ts";
import { FileSyncPolicy } from "../src/plugins/file-sync-policy.ts";

export const planApp = <R, E>(
  input: Omit<PlanAppInput, "appRoot"> & { readonly appRoot?: string },
  services: Layer.Layer<PluginRegistry | R, E>,
) =>
  assemble({ ...input, appRoot: input.appRoot ?? input.landofile.context.appRoot }).pipe(
    Effect.provide(FileSyncPolicy.layer.pipe(Layer.provideMerge(services))),
  );
