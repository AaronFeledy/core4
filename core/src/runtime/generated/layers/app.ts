/**
 * **GENERATED FILE** — do not edit by hand.
 *
 * Regenerate via `bun run scripts/build-bootstrap-layers.ts`.
 *
 * Source of truth: `scripts/build-bootstrap-layers.ts`, `BootstrapLevel`, and the
 * core runtime service membership graph.
 *
 * Bootstrap layer composition is emitted ahead of time so hand-authored
 * runtime factories do not rebuild the Effect Layer graph outside this
 * generated output.
 */

import { Context, Layer } from "effect";

import { engine as FileSyncEngineLive } from "@lando/file-sync-mutagen";
import { EventService } from "@lando/sdk/services";
import { makeSubscriberRuntimeLive } from "../../../lifecycle/subscribers.ts";
import { AppPlanResolverLive } from "../../../services/app-plan-resolver.ts";
import { BuildOrchestratorLive } from "../../../services/build-orchestrator.ts";
import { AppPlannerLive } from "../../../services/planner.ts";
import { ShellRunnerLive } from "../../../services/shell-runner.ts";
import { ProviderExecToolingEngineLive } from "../../../services/tooling-engine.ts";
import type { BootstrapLayerInputs } from "../../bootstrap-layer-support.ts";
import { makeProviderBootstrapBaseLayer } from "./provider.ts";

export const makeAppBootstrapLayer = (inputs: BootstrapLayerInputs) => {
  const providerBase = makeProviderBootstrapBaseLayer(inputs);
  const buildOrchestratorLive = Layer.suspend(() => BuildOrchestratorLive.pipe(Layer.provide(providerBase)));
  const plannerLive = AppPlannerLive.pipe(Layer.provide(providerBase));
  const resolverLive = AppPlanResolverLive.pipe(Layer.provide(Layer.merge(providerBase, plannerLive)));
  const appBase = Layer.mergeAll(
    providerBase,
    buildOrchestratorLive,
    plannerLive,
    resolverLive,
    ProviderExecToolingEngineLive,
    ShellRunnerLive,
    FileSyncEngineLive.pipe(Layer.provide(providerBase)),
  );
  const subscriberRuntimeLive = makeSubscriberRuntimeLive().pipe(Layer.provide(appBase));
  return Layer.merge(appBase, subscriberRuntimeLive).pipe(
    Layer.tap((context) => inputs.lifecycle.complete("app", Context.get(context, EventService))),
  );
};
