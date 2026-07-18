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

import { Layer } from "effect";

import { engine as FileSyncEngineLive } from "@lando/file-sync-mutagen";
import { LandofileServiceLive } from "../../../landofile/service.ts";
import { makeSubscriberRuntimeLive } from "../../../lifecycle/subscribers.ts";
import { BuildOrchestratorLive } from "../../../services/build-orchestrator.ts";
import { CommandRegistryLive } from "../../../services/command-registry.ts";
import { AppPlannerLive } from "../../../services/planner.ts";
import { ShellRunnerLive } from "../../../services/shell-runner.ts";
import { ProviderExecToolingEngineLive } from "../../../services/tooling-engine.ts";
import type { BootstrapLayerInputs } from "../../bootstrap-layer-support.ts";
import { makeProviderBootstrapBaseLayer } from "./provider.ts";

export const makeAppBootstrapLayer = (inputs: BootstrapLayerInputs) => {
  const providerBase = makeProviderBootstrapBaseLayer(inputs);
  const buildOrchestratorLive = Layer.suspend(() => BuildOrchestratorLive.pipe(Layer.provide(providerBase)));
  const commandRegistryLive = CommandRegistryLive.pipe(
    Layer.provide(Layer.mergeAll(LandofileServiceLive, providerBase)),
  );
  const appBase = Layer.mergeAll(
    providerBase,
    buildOrchestratorLive,
    LandofileServiceLive,
    commandRegistryLive,
    AppPlannerLive.pipe(Layer.provide(providerBase)),
    ProviderExecToolingEngineLive,
    ShellRunnerLive,
    FileSyncEngineLive.pipe(Layer.provide(providerBase)),
  );
  const subscriberRuntimeLive = makeSubscriberRuntimeLive().pipe(Layer.provide(appBase));
  return Layer.merge(appBase, subscriberRuntimeLive);
};
