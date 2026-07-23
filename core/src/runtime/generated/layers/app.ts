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
import { LandoRuntimeBootstrapError } from "@lando/sdk/errors";
import { EventService } from "@lando/sdk/services";
import { GlobalAppRuntimeLive } from "../../../global-app/runtime.ts";
import { makeSubscriberRuntimeLive } from "../../../lifecycle/subscribers.ts";
import { BuildOrchestratorLive } from "../../../services/build-orchestrator.ts";
import { AppPlannerLive } from "../../../services/planner.ts";
import { ShellRunnerLive } from "../../../services/shell-runner.ts";
import { ProviderExecToolingEngineLive } from "../../../services/tooling-engine.ts";
import { ProxyServiceRegistryLive, SelectedProxyServiceLive } from "../../../subsystems/proxy/registry.ts";
import type { BootstrapLayerInputs } from "../../bootstrap-layer-support.ts";
import { makeProviderBootstrapBaseLayer } from "./provider.ts";

export const makeAppBootstrapLayer = (inputs: BootstrapLayerInputs) => {
  const providerBase = makeProviderBootstrapBaseLayer(inputs);
  const buildOrchestratorLive = Layer.suspend(() => BuildOrchestratorLive.pipe(Layer.provide(providerBase)));
  const appBase = Layer.mergeAll(
    providerBase,
    buildOrchestratorLive,
    AppPlannerLive.pipe(Layer.provide(providerBase)),
    ProviderExecToolingEngineLive,
    ShellRunnerLive,
    FileSyncEngineLive.pipe(Layer.provide(providerBase)),
  );
  const proxyRegistryLive = ProxyServiceRegistryLive.pipe(
    Layer.provide(appBase),
    Layer.mapError(
      (cause) =>
        new LandoRuntimeBootstrapError({
          message: cause instanceof Error ? cause.message : "ProxyService bootstrap failed.",
          stage: "app",
          cause,
        }),
    ),
  );
  const globalAppRuntimeLive = GlobalAppRuntimeLive.pipe(Layer.provide(appBase));
  const proxyServiceLive = SelectedProxyServiceLive.pipe(
    Layer.provide(Layer.mergeAll(appBase, globalAppRuntimeLive, proxyRegistryLive)),
    Layer.mapError(
      (cause) =>
        new LandoRuntimeBootstrapError({
          message: cause instanceof Error ? cause.message : "ProxyService bootstrap failed.",
          stage: "app",
          cause,
        }),
    ),
  );
  const fullAppBase = Layer.mergeAll(appBase, globalAppRuntimeLive, proxyRegistryLive, proxyServiceLive);
  const subscriberRuntimeLive = makeSubscriberRuntimeLive().pipe(Layer.provide(fullAppBase));
  return Layer.merge(fullAppBase, subscriberRuntimeLive).pipe(
    Layer.tap((context) => inputs.lifecycle.complete("app", Context.get(context, EventService))),
  );
};
